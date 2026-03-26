import { ethers } from 'ethers';
import https from 'https';
import { PrimusZkTLS } from './primusZkTLS.js';
import { ConfigManager } from './configManager.js';
import { X402Payment } from './shared/x402.js';
import { XMTPMessenger } from './shared/xmtp.js';
import { SignalStore } from './signalStore.js';
import { EncryptedSignalService } from './encryptedSignalService.js';
import { OkxDexMCP } from './okxDexMCP.js';
import { TrustedScoreCalculator } from './trustedScore.js';

const noProxyHttpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: true });

async function httpPost(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const body = JSON.stringify(data);
    const options = {
      hostname: urlObj.hostname, port: 443, path: urlObj.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
      agent: noProxyHttpsAgent
    };
    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(responseBody)); } catch (e) { reject(new Error(responseBody.substring(0, 200))); } });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

export class ToolAgent {
  constructor(config) {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.providerWallet = new ethers.Wallet(config.providerPrivateKey, this.provider);
    this.consumerWallet = new ethers.Wallet(config.consumerPrivateKey, this.provider);
    this.llmApiKey = config.llmApiKey;
    this.llmModel = config.llmModel || 'qwen-plus';
    this.llmBaseUrl = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';
    
    this.configManager = new ConfigManager();
    this.x402 = new X402Payment(config.rpcUrl);
    this.xmtp = new XMTPMessenger();
    
    //  每个 Provider 有自己的存储
    this.signalStore = new SignalStore(this.providerWallet.address);
    
    if (config.primusAppId && config.primusAppSecret) {
      this.primusZkTLS = new PrimusZkTLS(config.primusAppId, config.primusAppSecret);
      console.log(' Primus zkTLS Initialized');
    }
    
    this.okxCreds = {
      apiKey: config.okxApiKey,
      secretKey: config.okxSecretKey,
      passphrase: config.okxPassphrase
    };
    
    // 初始化 OKX DEX MCP 客户端
    this.okxDexMCP = new OkxDexMCP();
    
    // 初始化Trusted score计算器
    this.trustedScore = new TrustedScoreCalculator();
    
    this.signalMarket = new ethers.Contract(
      config.signalMarketAddress, 
      [
        'function nextSignalId() view returns (uint256)',
        'function getSignal(uint256) view returns (tuple(uint256 signalId, address providerAddress, uint256 publishTime, bytes32 publishTxHash, string metaContent, uint256 priceOKB, uint256 expireTime, bytes32 proofId, uint256 trustedScore, bool active))',
        'function purchaseSignal(uint256 signalId, string buyerPublicKey) external payable returns (uint256)',
        'function recordDelivery(uint256 purchaseId, string encryptedContent) external',
        'function hasDelivery(uint256, address) view returns (bool)',
        'function submitRating(uint256, uint8, string) external',
        'function publishSignal(uint256 trustedScore, uint256 signalId, string metaContent, uint256 priceOKB, uint256 expireHours, tuple(address recipient, tuple(string url, string header, string method, string body) request, tuple(string keyName, string parseType, string parsePath)[] reponseResolve, string data, string attConditions, uint64 timestamp, string additionParams, tuple(address attestorAddr, string url)[] attestors, bytes[] signatures) attestation, bytes32 publishTxHash) external returns (uint256)',
        'event SignalPublished(uint256 indexed signalId, address indexed providerAddress, uint256 publishTime, uint256 priceOKB, uint256 expireTime)'
      ],
      this.provider
    );
    
    this.agentRegistry = new ethers.Contract(
      config.agentRegistryAddress, 
      [
        'function getReputation(address) view returns (uint256, uint256)',
        'function getAgent(address) view returns (tuple(string name, string serviceUrl, address walletAddress, bytes32 latestProofId, uint256 reputationScore, uint256 totalRatings, bool isProvider, bool active, uint256 registeredAt))'
      ],
      this.provider
    );
    
    // Initialize encrypted signal service
    if (config.signalEscrowAddress && config.publicKeyRegistryAddress) {
      const signalEscrow = new ethers.Contract(
        config.signalEscrowAddress,
        [
          'function purchase(uint256 signalId, address provider, string calldata buyerPublicKey) external payable returns (uint256)',
          'function deliver(uint256 purchaseId, string calldata encryptedContent) external',
          'function confirmDelivery(uint256 purchaseId) external',
          'function refund(uint256 purchaseId, uint256 timeoutSeconds) external',
          'function getPendingDeliveries(address provider) view returns (uint256[])',
          'function getEncryptedSignals(address buyer) view returns (uint256[])',
          'function getPurchase(uint256 purchaseId) view returns (uint256, address, address, address, uint256, string, uint256, bool, bool, bool)',
          'function getEncryptedContent(uint256 purchaseId) view returns (string, uint256)'
        ],
        this.provider
      );
      
      const publicKeyRegistry = new ethers.Contract(
        config.publicKeyRegistryAddress,
        [
          'function registerPublicKey(string calldata publicKey) external',
          'function getPublicKey(address user) view returns (string)',
          'function isRegistered(address user) view returns (bool)'
        ],
        this.provider
      );
      
      // Provider service(for auto delivery)
      this.encryptedSignalProvider = new EncryptedSignalService(
        signalEscrow,
        publicKeyRegistry,
        this.providerWallet
      );
      
      // Buyer service(for auto download and decrypt)
      this.encryptedSignalBuyer = new EncryptedSignalService(
        signalEscrow,
        publicKeyRegistry,
        this.consumerWallet
      );
      
      // Start auto polling
      this.startAutoPolling();
      
      console.log('   Encrypted signal service: ');
    }
    
    console.log(' ToolAgent Initialized (Full version)');
    console.log('   Provider Address: ' + this.providerWallet.address.substring(0, 15) + '...');
    console.log('   Payment module: x402 ✓');
    console.log('   Communication module: XMTP ✓');
    console.log('   zkTLS module: Primus ✓');
    console.log('   Local storage: SignalStore ✓');
    console.log('   Encrypted signal service: ');
    console.log('');
  }
  
  /**
   * Start auto polling(Provider 交付 + Buyer 下载)
   */
  async startAutoPolling() {
    console.log('\n🔄 Start auto polling服务...');
    
    // Provider: Poll pending delivery every 10s
    setInterval(async () => {
      try {
        const pending = await this.encryptedSignalProvider.pollPendingDeliveries();
        if (pending.length > 0) {
          console.log(`📬 Found ${pending.length} pending delivery`);
          for (const purchase of pending) {
            // Get signal content
            const signalData = this.signalStore.getFullSignal(purchase.signalId.toString());
            if (signalData && signalData.content) {
              console.log(`🔐 Deliver Purchase #${purchase.purchaseId}...`);
              const result = await this.encryptedSignalProvider.deliverEncryptedSignal(
                purchase.purchaseId,
                signalData.content
              );
              if (result.success) {
                console.log(` Delivery successful: ${result.txHash}`);
              }
            }
          }
        }
      } catch (e) {
        console.error('Error:  Provider 轮询Failed:', e.message);
      }
    }, 10000);
    
    // Buyer: Poll delivered every 10s
    setInterval(async () => {
      try {
        const signals = await this.encryptedSignalBuyer.pollEncryptedSignals();
        if (signals.length > 0) {
          console.log(`📥 Found ${signals.length} 个待下载`);
          for (const signal of signals) {
            console.log(`🔓 Decrypt Purchase #${signal.purchaseId}...`);
            const result = await this.encryptedSignalBuyer.decryptLocalSignal(signal.purchaseId);
            if (result.success) {
              console.log(` Decryption successful`);
            }
          }
        }
      } catch (e) {
        console.error('Error:  Buyer 轮询Failed:', e.message);
      }
    }, 10000);
    
    console.log(' Auto polling started(10 s interval)');
  }
  
  async manageConfig(action, params) {
    if (action === 'status') {
      const status = this.configManager.checkStatus();
      return {
        reply: `Signal  ConfigurationStatus检查\n\n` +
               `OKX API: ${status.sections['OKX API'] ? '' : 'Error: '}\n` +
               `Primus zkTLS: ${status.sections['Primus zkTLS'] ? '' : 'Error: '}\n` +
               `LLM: ${status.sections['LLM'] ? '' : 'Error: '}\n` +
               `钱包: ${status.sections['钱包Configuration'] ? '' : 'Error: '}\n\n` +
               (status.complete ? ' 所有Configuration已就绪' : `Warning:  缺失Configuration: ${status.missing.join(', ')}`)
      };
    }
    if (action === 'set') {
      const result = this.configManager.update(params.key, params.value);
      if (result.success) return { reply: ` Set ${params.key} = ${params.value.substring(0, 10)}...` };
      else return { reply: `Error:  设置Failed: ${result.error}` };
    }
    if (action === 'show') {
      const safe = this.configManager.getSafeConfig();
      let reply = '📋 当前Configuration:\n\n';
      Object.entries(safe).forEach(([key, value]) => { if (value) reply += `${key}: ${value}\n`; });
      return { reply };
    }
    return { reply: ' I do not understand, trySay "检查Configuration"、"查看Configuration"' };
  }
  
  async listSignals() {
    try {
      console.log('[listSignals] Querying SignalPublished events...');
      
      const currentBlock = await this.provider.getBlockNumber();
      const batchSize = 100;
      const fromBlock = Math.max(0, currentBlock - 10000);
      
      // SignalPublished 事件 topic(5 个参数版本，匹配Chain上合约)
      const signalPublishedTopic = '0x1c0a5b2c2d0168fbe82a6d97c9fbcfba5b3ac848280ee109438c0e569a657911';
      
      const signalMap = new Map();
      
      // Batch query event logs
      for (let batchStart = fromBlock; batchStart <= currentBlock; batchStart += batchSize) {
        const batchEnd = Math.min(batchStart + batchSize - 1, currentBlock);
        try {
          const logs = await this.provider.getLogs({
            address: await this.signalMarket.getAddress(),
            fromBlock: batchStart,
            toBlock: batchEnd,
            topics: [signalPublishedTopic]
          });
          
          for (const log of logs) {
            try {
              const signalId = BigInt(log.topics[1]);
              const signal = await this.signalMarket.getSignal(signalId);
              signalMap.set(signalId.toString(), signal);
            } catch (e) {
              console.error('[listSignals] Error processing event:', e.message);
            }
          }
        } catch (e) {
          console.error('[listSignals] Error querying batch:', batchStart, '-', batchEnd, e.message);
        }
      }
      
      const total = signalMap.size;
      let reply = `Total **${total}**  signals\n\n`;
      reply += `ID | Currency | 有效Time | Price | Trusted Score | Publish Tx Hash\n`;
      reply += `---|------|----------|------|--------|----------------\n`;
      
      if (total === 0) {
        reply += 'No signals available';
        console.log('[listSignals] Reply:', reply);
        return reply;
      }
      
      // Show all signals
      for (const [signalId, signal] of signalMap.entries()) {
        try {
          const meta = JSON.parse(signal.metaContent);
          const instId = meta.instId || 'UNKNOWN';
          const expireHours = meta.expireHours || '24';
          const price = parseFloat(ethers.formatEther(signal.priceOKB));
          const trustedScore = signal.trustedScore || 0;
          const scoreIcon = trustedScore >= 10 ? '🟢' : trustedScore >= 7 ? '🔵' : trustedScore >= 4 ? '🟡' : '⚪';
          
          let publishTx = signal.publishTxHash && signal.publishTxHash !== ethers.ZeroHash 
            ? signal.publishTxHash 
            : 'N/A';
          
          reply += `#${signalId} | ${instId} | ${expireHours}h | ${price} OKB | ${scoreIcon} ${trustedScore}分 | ${publishTx}\n`;
        } catch (e) {
          console.error('[listSignals] Error getting signal', signalId, e.message);
        }
      }
      
      console.log('[listSignals] Reply:', reply);
      return reply;
    } catch (e) {
      console.error('[listSignals] Error:', e.message);
      return 'Query failed: ' + e.message.substring(0, 100);
    }
  }
  
  async viewSignal(params) {
    try {
      // 如果没有指定 signalId，Show all signals
      if (!params.signalId) {
        const listReply = await this.listSignals();
        return { success: true, message: listReply };
      }
      
      const signal = await this.signalMarket.getSignal(params.signalId);
      const meta = JSON.parse(signal.metaContent);
      
      let reply = `Signal #${signal.signalId}\n\n`;
      reply += `**Public information**:\n`;
      reply += `- Currency: ${meta.instId || 'UNKNOWN'}\n`;
      reply += `- 有效Time: ${meta.expireHours || '24'} hours\n`;
      reply += `- Price: ${parseFloat(ethers.formatEther(signal.priceOKB))} OKB\n`;
      reply += `- Provider: ${signal.providerAddress}\n`;
      reply += `- Status: ${signal.active ? '✓ Active' : '✗ Expired'}\n`;
      
      // 显示Trusted score
      if (signal.trustedScore > 0) {
        const scoreLevel = signal.trustedScore >= 10 ? 'Excellent' : 
                          signal.trustedScore >= 7 ? 'Good' : 
                          signal.trustedScore >= 4 ? 'Fair' : 'Poor';
        reply += `- Trusted score: ${signal.trustedScore} 分 - ${scoreLevel}\n`;
      }
      
      reply += `\n**zkTLS Proof**:\n`;
      reply += `- Proof ID: ${signal.proofId}\n`;
      reply += `- Publish transaction: ${signal.publishTxHash || 'N/A'}\n\n`;
      
      reply += `Tip:  Say "买信号 ${signal.signalId}"  to purchase，购买后可查看Full content`;
      
      return { success: true, message: reply };
    } catch (e) {
      return { success: false, message: 'View failed: ' + e.message.substring(0, 100) };
    }
  }
  
  async decryptSignal(params) {
    try {
      // 从Local storage读取加密内容
      const signalData = this.signalStore.getFullSignal(params.signalId);
      
      if (!signalData || !signalData.content) {
        return { success: false, message: 'Error: Signal content not found' };
      }
      
      let reply = `Signal #${params.signalId} Full content\n\n`;
      reply += `**Publish transaction**: ${signalData.proofTxHash || 'N/A'}\n\n`;
      reply += `**Signal details**:\n${signalData.content}`;
      
      return { success: true, message: reply };
    } catch (e) {
      return { success: false, message: 'Decryption failed: ' + e.message.substring(0, 100) };
    }
  }
  
  async checkReputation() {
    try {
      const [score, count] = await this.agentRegistry.getReputation(this.providerWallet.address);
      const agent = await this.agentRegistry.getAgent(this.providerWallet.address);
      return `Provider: ${agent.name}\nReputation score: ${score}\nNumber of ratings: ${count}\nStatus: ${agent.active ? '✓ Active' : '✗'}`;
    } catch (e) { return 'Query failed: ' + e.message.substring(0, 100); }
  }
  
  async getWalletBalance() {
    const balance = await this.provider.getBalance(this.providerWallet.address);
    return {
      reply: `Price  钱包OKB Balance查询\n\n` +
        `• Address: \`${this.providerWallet.address.substring(0, 10)}...\`\n` +
        `• OKB Balance: ${parseFloat(ethers.formatEther(balance)).toFixed(4)} OKB`
    };
  }
  
  /**
   * 查询代币Price(OKX DEX Market)
   */
  async getTokenPrice(params) {
    try {
      const { token, chain } = params;
      
      if (!token) {
        return { reply: `Error:  Please specify token name or address\n\nExample: "BTC Price"、"ETH How much"` };
      }
      
      console.log('[DEX Market] Querying price:', token);
      
      const result = await this.okxDexMarket('price', { token, chain });
      
      if (!result.success) {
        return { reply: `Error:  Query failed: ${result.message}` };
      }
      
      // 解析 MCP 返回的数据
      const data = result.data;
      let priceText = 'No data available';
      
      if (data?.content?.[0]?.text) {
        try {
          const priceData = JSON.parse(data.content[0].text);
          if (Array.isArray(priceData) && priceData.length > 0) {
            const p = priceData[0];
            priceText = `$${p.price || p.usdPrice || 'N/A'}\n` +
                       `24h 涨跌: ${p.change || p.change24h || 'N/A'}%\n` +
                       `市值: $${p.marketCap || p.mcap || 'N/A'}\n` +
                       `Chain: ${p.chainName || p.chain || 'N/A'}`;
          } else if (priceData.price) {
            priceText = `$${priceData.price}\n24h 涨跌: ${priceData.change24h || 0}%`;
          }
        } catch (e) {
          priceText = data.content[0].text;
        }
      }
      
      return { reply: `Price  ${token} Price查询\n\n${priceText}` };
      
    } catch (e) {
      console.error('[Token Price] Error:', e.message);
      return { reply: `Error:  Query failed: ${e.message}` };
    }
  }
  
  /**
   * 查询Whale/Smart Moneybuy signals(OKX DEX Signal)
   */
  async getSmartMoneySignals(params) {
    try {
      const { chain, walletType, minAmountUsd } = params;
      
      console.log('[DEX Signal] Querying signals:', chain, walletType);
      
      const result = await this.okxDexMarket('signals', { chain, walletType, minAmountUsd, limit: 10 });
      
      if (!result.success) {
        return { reply: `Error:  Query failed: ${result.message}` };
      }
      
      const data = result.data;
      
      if (data?.content?.[0]?.text) {
        try {
          const signals = JSON.parse(data.content[0].text);
          
          if (!signals || signals.length === 0) {
            return { reply: `No signals No signals available\n\n当前没有符合条件的buy signals` };
          }
          
          let reply = `Whale  Whale buy signals\n\n`;
          reply += `Chain: ${chain || 'all'}\n`;
          reply += `Number of signals: ${signals.length}\n\n`;
          
          signals.slice(0, 10).forEach((signal, idx) => {
            // 处理嵌套的 token 对象
            const token = signal.token || signal.tokenInfo || {};
            const tokenSymbol = token.symbol || signal.tokenSymbol || signal.symbol || 'Unknown';
            const tokenName = token.name || signal.tokenName || '';
            
            // 钱包Type映射
            const walletTypeMap = { 
              '1': 'Smart Money', '2': 'KOL', '3': 'Whale', 
              'SMART_MONEY': 'Smart Money', 'INFLUENCER': 'KOL', 'WHALE': 'Whale' 
            };
            const walletTypeName = walletTypeMap[signal.walletType] || walletTypeMap[walletType] || signal.walletType || '未知';
            
            // Amount
            const amountUsd = parseFloat(signal.amountUsd || 0);
            
            // Trigger wallet count
            const triggerCount = signal.triggerWalletCount || signal.triggerWalletCount || 1;
            
            // Sold ratio - 可能是小数或百分比
            let soldRatio = parseFloat(signal.soldRatioPercent || 0);
            if (soldRatio > 1) soldRatio = soldRatio;  // already percentage
            else soldRatio = soldRatio * 100;  // 小数转百分比
            
            // Time戳
            const timestamp = signal.timestamp || signal.signalTime || signal.time;
            const signalTime = timestamp ? new Date(parseInt(timestamp)).toLocaleString('zh-CN') : 'N/A';
            
            reply += `${idx + 1}. **${tokenSymbol}** ${tokenName ? `(${tokenName})` : ''}\n`;
            reply += `   Type: ${walletTypeName}\n`;
            reply += `   Amount: $${amountUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
            reply += `   Trigger wallet count: ${triggerCount}\n`;
            reply += `   Sold ratio: ${soldRatio.toFixed(1)}%\n`;
            reply += `   Signal time: ${signalTime}\n`;
            
            if (token.logo) {
              reply += `   代币: ${tokenSymbol}\n`;
            }
            
            reply += `\n`;
          });
          
          return { reply };
          
        } catch (e) {
          console.error('[Signal Parse Error]:', e.message);
          return { reply: `Signal query result\n\n${data.content[0].text.substring(0, 1000)}` };
        }
      }
      
      return { reply: `Error:  未获取到Number of signals据` };
      
    } catch (e) {
      console.error('[Smart Money Signals] Error:', e.message);
      return { reply: `Error:  Query failed: ${e.message}` };
    }
  }
  
  /**
   * 查询Trader leaderboard(OKX DEX Signal Leaderboard)
   */
  async getLeaderboard(params) {
    try {
      const { chain, timeFrame, sortBy, walletType } = params;
      
      console.log('[DEX Leaderboard] Querying:', chain, timeFrame, sortBy);
      
      const result = await this.okxDexMarket('leaderboard', { 
        chain: chain || 'solana', 
        timeFrame: timeFrame || 3, 
        sortBy: sortBy || 1, 
        walletType,
        limit: 20 
      });
      
      if (!result.success) {
        return { reply: `Error:  Query failed: ${result.message}` };
      }
      
      const data = result.data;
      
      if (data?.content?.[0]?.text) {
        try {
          const leaderboard = JSON.parse(data.content[0].text);
          
          if (!leaderboard || leaderboard.length === 0) {
            return { reply: `No signals No leaderboard data` };
          }
          
          const sortByMap = { '1': 'PnL', '2': 'Win rate', '3': 'Trade count', '4': 'Volume', '5': 'ROI' };
          const timeFrameMap = { '1': '1 天', '2': '3 天', '3': '7 天', '4': '30 天', '5': '90 天' };
          
          let reply = `Leaderboard  Trader leaderboard\n\n`;
          reply += `Chain: ${chain || 'Solana'}\n`;
          reply += `Time: ${timeFrameMap[timeFrame] || '7 天'}\n`;
          reply += `Sort by: ${sortByMap[sortBy] || 'PnL'}\n\n`;
          
          leaderboard.slice(0, 20).forEach((trader, idx) => {
            const walletAddr = trader.walletAddress || trader.wallet || 'Unknown';
            const shortAddr = walletAddr.length > 12 ? `${walletAddr.substring(0, 6)}...${walletAddr.substring(walletAddr.length - 4)}` : walletAddr;
            
            reply += `${idx + 1}. \`${shortAddr}\`\n`;
            reply += `   PnL: $${parseFloat(trader.pnl || trader.realizedPnl || 0).toLocaleString('en-US')}\n`;
            reply += `   Win rate: ${((trader.winRate || 0) * 100).toFixed(1)}%\n`;
            reply += `   Trade count: ${trader.txCount || trader.tradeCount || 0}\n`;
            reply += `   Volume: $${parseFloat(trader.volume || trader.tradeVolume || 0).toLocaleString('en-US')}\n\n`;
          });
          
          return { reply };
          
        } catch (e) {
          return { reply: `Leaderboard  排行榜数据\n\n${data.content[0].text.substring(0, 1000)}` };
        }
      }
      
      return { reply: `Error:  No leaderboard data retrieved` };
      
    } catch (e) {
      console.error('[Leaderboard] Error:', e.message);
      return { reply: `Error:  Query failed: ${e.message}` };
    }
  }
  
  /**
   * Query kline data(OKX DEX Market)
   */
  async getTokenKline(params) {
    try {
      const { token, chain, interval } = params;
      
      if (!token) {
        return { reply: `Error:  请指定代币名称\n\nExample: "BTC K 线"、"ETH 走势"` };
      }
      
      console.log('[DEX Market] Querying kline:', token, interval || '1h');
      
      const result = await this.okxDexMarket('kline', { token, chain, interval: interval || '1h' });
      
      if (!result.success) {
        return { reply: `Error:  Query failed: ${result.message}` };
      }
      
      const data = result.data;
      const klines = data.klines || [];
      
      let reply = ` ${data.symbol || token} K 线走势\n\n`;
      
      if (klines.length === 0) {
        reply += `ℹ️ 暂无 K 线数据`;
      } else {
        // 显示最近 5 条 K 线
        const recent = klines.slice(-5);
        reply += `**最近走势**:\n\n`;
        
        recent.forEach((k, idx) => {
          const time = new Date(k.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
          const open = parseFloat(k.open).toFixed(6);
          const high = parseFloat(k.high).toFixed(6);
          const low = parseFloat(k.low).toFixed(6);
          const close = parseFloat(k.close).toFixed(6);
          const change = ((close - open) / open * 100);
          const icon = change >= 0 ? '🟢' : '🔴';
          
          reply += `${icon} ${time} | O:${open} H:${high} L:${low} C:${close} **(${change >= 0 ? '+' : ''}${change.toFixed(2)}%)**\n`;
        });
        
        // 统计涨跌
        const upCount = recent.filter(k => parseFloat(k.close) > parseFloat(k.open)).length;
        const trend = upCount >= 3 ? ' 偏多' : upCount <= 2 ? ' 偏空' : '➡️ 震荡';
        
        reply += `\n近期趋势: ${trend}`;
      }
      
      return { reply };
      
    } catch (e) {
      console.error('[Token Kline] Error:', e.message);
      return { reply: `Error:  Query failed: ${e.message.substring(0, 200)}` };
    }
  }
  
  /**
   * Query wallet PnL(OKX DEX Market)
   */
  async getWalletPnL(params) {
    try {
      const { address, chain } = params;
      const walletAddress = address || this.providerWallet.address;
      
      console.log('[DEX Market] Querying PnL:', walletAddress);
      
      const result = await this.okxDexMarket('pnl', { address: walletAddress, chain });
      
      if (!result.success) {
        return { reply: `Error:  Query failed: ${result.message}` };
      }
      
      const data = result.data;
      
      let reply = `Price  钱包 PnL 分析\n\n`;
      reply += `📍 Address: \`${walletAddress.substring(0, 10)}...${walletAddress.substring(walletAddress.length - 8)}\`\n\n`;
      
      if (data.totalPnL !== undefined) {
        const pnl = parseFloat(data.totalPnL);
        const pnlIcon = pnl >= 0 ? '' : '';
        reply += `├ 总盈亏: ${pnlIcon} **$${pnl.toLocaleString('en-US', { minimumFractionDigits: 2 })}**\n`;
      }
      
      if (data.realizedPnL !== undefined) {
        reply += `├ Realized PnL: $${parseFloat(data.realizedPnL).toLocaleString('en-US', { minimumFractionDigits: 2 })}\n`;
      }
      
      if (data.unrealizedPnL !== undefined) {
        reply += `├ 未实现盈亏: $${parseFloat(data.unrealizedPnL).toLocaleString('en-US', { minimumFractionDigits: 2 })}\n`;
      }
      
      if (data.winRate !== undefined) {
        reply += `├ Win rate: **${(data.winRate * 100).toFixed(1)}%**\n`;
      }
      
      if (data.tradeCount !== undefined) {
        reply += `├ 交易次数: ${data.tradeCount}\n`;
      }
      
      // 显示最赚钱的代币
      if (data.topTokens && data.topTokens.length > 0) {
        reply += `\n**最赚钱的代币**:\n\n`;
        data.topTokens.slice(0, 3).forEach((t, idx) => {
          const pnl = parseFloat(t.pnl || 0);
          reply += `${idx + 1}. ${t.symbol}: $${pnl.toLocaleString('en-US', { minimumFractionDigits: 2 })}\n`;
        });
      }
      
      return { reply };
      
    } catch (e) {
      console.error('[Wallet PnL] Error:', e.message);
      return { reply: `Error:  Query failed: ${e.message.substring(0, 200)}` };
    }
  }
  
  /**
   * 查询Smart Money交易动态(OKX DEX Market)
   */
  async getSmartMoneyTrades(params) {
    try {
      const { type, chain, limit } = params;
      
      console.log('[DEX Market] Querying smart money trades:', type || 'buy', chain || 'all');
      
      const result = await this.okxDexMarket('smartmoney', { type: type || 'buy', chain, limit: limit || 5 });
      
      if (!result.success) {
        return { reply: `Error:  Query failed: ${result.message}` };
      }
      
      const data = result.data;
      const trades = data.trades || [];
      
      let reply = `Whale  Smart Money交易动态\n\n`;
      
      if (trades.length === 0) {
        reply += `ℹ️ 暂无交易记录`;
      } else {
        trades.forEach((trade, idx) => {
          const action = trade.action === 'buy' ? '🟢 买入' : '🔴 卖出';
          const usdValue = parseFloat(trade.usdValue || 0).toLocaleString('en-US', { minimumFractionDigits: 0 });
          
          reply += `${idx + 1}. **${action}** ${trade.symbol || 'Unknown'}\n`;
          reply += `   Amount: $${usdValue} | Address: \`${trade.wallet.substring(0, 8)}...\`\n`;
          reply += `   Time: ${new Date(trade.timestamp).toLocaleString('zh-CN')}\n\n`;
        });
      }
      
      return { reply };
      
    } catch (e) {
      console.error('[Smart Money] Error:', e.message);
      return { reply: `Error:  Query failed: ${e.message.substring(0, 200)}` };
    }
  }
  
  /**
   * OKX DEX Market API 调用(通过 MCP)
   */
  async okxDexMarket(type, params) {
    console.log('[OKX DEX] Type:', type, 'Params:', params);
    
    switch (type) {
      case 'price':
        return await this.okxDexMCP.getTokenPrice(params.token, params.chain);
      case 'kline':
        return await this.okxDexMCP.getTokenKline(params.token, params.interval, params.chain, params.limit);
      case 'pnl':
        return await this.okxDexMCP.getWalletPnL(params.address, params.chain);
      case 'signals':
        return await this.okxDexMCP.getSmartMoneySignals(params.chain, params.walletType, params.minAmountUsd, params.limit);
      case 'signal_chains':
        return await this.okxDexMCP.getSignalChains();
      case 'leaderboard':
        return await this.okxDexMCP.getLeaderboard(params.chain, params.timeFrame, params.sortBy, params.walletType, params.minTxs, params.limit);
      case 'leaderboard_chains':
        return await this.okxDexMCP.getLeaderboardChains();
      default:
        return { success: false, message: '不支持的查询Type: ' + type };
    }
  }
  
  /**
   * 查询Wallet portfolio(OKX Portfolio)
   * @param {Object} params - { address?: string, chain?: string }
   */
  async checkWalletPortfolio(params) {
    try {
      const address = params.address || this.providerWallet.address;
      const chain = params.chain || 'all';
      
      console.log('[Portfolio] Querying:', address, chain);
      
      // 调用 OKX API
      const result = await this.okxWalletPortfolio(address, chain);
      
      if (!result.success) {
        return { reply: `Error:  Query failed: ${result.message}` };
      }
      
      const data = result.data;
      const chains = data.chains || [];
      
      // 构建友好的回复
      let reply = `💼 Wallet portfolio\n\n`;
      reply += `📍 Address: \`${address.substring(0, 10)}...${address.substring(address.length - 8)}\`\n\n`;
      
      if (chains.length === 0) {
        reply += `ℹ️ 该AddressNo asset records`;
      } else {
        reply += `├ Total estimate: **$${parseFloat(data.totalUsd || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}**\n`;
        reply += `├ 支持Chain数: ${chains.length}\n\n`;
        
        // Estimated at估值Sort by显示前 5 条Chain
        const topChains = chains
          .sort((a, b) => parseFloat(b.usd || 0) - parseFloat(a.usd || 0))
          .slice(0, 5);
        
        for (const c of topChains) {
          const usd = parseFloat(c.usd || 0);
          const chainName = c.chain || c.chainName || 'Unknown';
          if (usd > 0) {
            reply += `• **${chainName}**: $${usd.toLocaleString('en-US', { minimumFractionDigits: 2 })}\n`;
          }
        }
        
        if (chains.length > 5) {
          reply += `\n... More ${chains.length - 5} 条Chain`;
        }
      }
      
      return { reply };
      
    } catch (e) {
      console.error('[Portfolio] Error:', e.message);
      return { reply: `Error:  Query failed: ${e.message.substring(0, 200)}` };
    }
  }
  
  /**
   * OKX Wallet Portfolio API 调用
   */
  async okxWalletPortfolio(address, chain = 'all') {
    try {
      // 检查是否Configuration了 OKX API
      if (!this.okxCreds?.apiKey || !this.okxCreds?.secretKey || !this.okxCreds?.passphrase) {
        return { 
          success: false, 
          message: 'Warning:  OKX API Configuration不完整\n\nRequires setting: OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE'
        };
      }
      
      console.log('[OKX] Using API Key:', this.okxCreds.apiKey.substring(0, 8) + '...');
      console.log('[OKX] Address:', address);
      
      // 生成签名所需的 timestamp
      const timestamp = new Date().toISOString();
      const method = 'GET';
      const requestPath = '/api/v5/defi/portfolio/summary';
      const queryString = `?address=${address}&chain=${chain}`;
      const signStr = timestamp + method + (requestPath + queryString);
      
      // 生成签名
      const crypto = await import('crypto');
      const signature = crypto
        .createHmac('sha256', this.okxCreds.secretKey)
        .update(signStr)
        .digest('base64');
      
      const url = `https://www.okx.com${requestPath}${queryString}`;
      
      // 发起 HTTPS 请求
      const https = await import('https');
      const response = await new Promise((resolve, reject) => {
        const req = https.get(url, {
          headers: {
            'OK-ACCESS-KEY': this.okxCreds.apiKey,
            'OK-ACCESS-SIGN': signature,
            'OK-ACCESS-TIMESTAMP': timestamp,
            'OK-ACCESS-PASSPHRASE': this.okxCreds.passphrase,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              console.log('[OKX] Response code:', parsed.code);
              if (parsed.code !== '0') {
                console.log('[OKX] Response msg:', parsed.msg);
              }
              resolve(parsed);
            } catch (e) {
              reject(new Error('解析Failed: ' + data.substring(0, 200)));
            }
          });
        });
        
        req.on('error', (e) => {
          console.error('[OKX] Request error:', e.message);
          reject(new Error('网络Error: ' + e.message));
        });
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('请求超时 (15 秒)'));
        });
      });
      
      if (response.code === '0') {
        console.log('[OKX] Success!');
        return { success: true, data: response.data[0] || {} };
      } else {
        return { success: false, message: response.msg || 'API 调用Failed (' + response.code + ')' };
      }
      
    } catch (e) {
      console.error('[OKX Portfolio] Error:', e.message);
      return { 
        success: false, 
        message: e.message
      };
    }
  }
  
  async buySignal(params) {
    try {
      console.log('\nGet purchase signal info...');
      
      const signal = await this.signalMarket.getSignal(params.signalId);
      const publicMeta = JSON.parse(signal.metaContent);
      const priceOKB = parseFloat(ethers.formatEther(signal.priceOKB));
      
      if (!signal.active) {
        return { 
          success: false, 
          message: 'Error:  信号已Expired，无法购买' 
        };
      }
      
      // 检查是否是自己Published的信号
      const consumerAddress = this.consumerWallet.address.toLowerCase();
      const isOwnSignal = signal.providerAddress.toLowerCase() === consumerAddress;
      
      if (isOwnSignal) {
        return {
          success: false,
          message: 'Warning:  这是您自己Published的信号，无需购买'
        };
      }
      
      // 返回购买信息，由前端执行钱包签名
      return {
        success: true,
        signalId: signal.signalId.toString(),
        provider: signal.providerAddress,
        priceOKB: priceOKB,
        priceWei: signal.priceOKB.toString(),
        instId: publicMeta.instId,
        message: `Signal #${signal.signalId}\n- Currency: ${publicMeta.instId}\n- Price: ${priceOKB} OKB\n- Provider: ${signal.providerAddress.substring(0, 10)}...`
      };
      
    } catch (e) {
      console.error('\nError:  获取购买信息Failed:', e.message);
      return { success: false, message: 'Error:  Purchase failed: ' + e.message.substring(0, 200) };
    }
  }
  
  async deliverSignal(params) {
    try {
      console.log('\n📤 记录交付...');
      const tx = await this.signalMarket.connect(this.providerWallet).recordDelivery(params.signalId, params.consumerAddress);
      console.log('   交易: ' + tx.hash);
      await tx.wait();
      console.log('    交付已记录');
      return { success: true, message: ` 交付已记录！\n交易: ${tx.hash}`, txHash: tx.hash };
    } catch (e) {
      console.error('\nError:  Delivery failed:', e.message);
      return { success: false, message: 'Error:  Delivery failed: ' + e.message.substring(0, 200) };
    }
  }
  
  async submitRating(params) {
    try {
      console.log('\n⭐ 提交评分...');
      const tx = await this.signalMarket.connect(this.consumerWallet).submitRating(params.signalId, params.score, params.comment || '很好！');
      console.log('   交易: ' + tx.hash);
      await tx.wait();
      console.log('    评分已提交');
      return { success: true, message: ` 评分已提交！\n交易: ${tx.hash}`, txHash: tx.hash };
    } catch (e) {
      console.error('\nError:  评分Failed:', e.message);
      return { success: false, message: 'Error:  评分Failed: ' + e.message.substring(0, 200) };
    }
  }
  
  async publishSignal(params) {
    if (!this.primusZkTLS) {
      return { success: false, message: 'Warning:  Primus Not configured\n\n请Say "检查Configuration" 查看缺失项' };
    }
    if (!this.okxCreds.apiKey) {
      return { success: false, message: 'Warning:  OKX API Not configured\n\n请Say "检查Configuration" 查看缺失项' };
    }
    
    try {
      console.log('\n🔐 正在通过 Primus zkTLS 获取真实交易数据...');
      const proofResult = await this.primusZkTLS.proveAll(params.instId || 'BTC-USDT');
      
      if (!proofResult.success) {
        return { success: false, message: 'Error:  生成 zkTLS ProofFailed: ' + proofResult.error };
      }
      
      console.log('\n 准备Published到Chain上...');
      
      //  Chain上 Meta-data: Currency + 有效Time + Price
      const publicMeta = {
        instId: params.instId || 'BTC-USDT',
        expireHours: parseInt(params.expireHours || '24'),
        priceOKB: parseFloat(params.price || '0.01')
      };
      const metaContent = JSON.stringify(publicMeta);
      
      //  本地保存完整 Content(字符串格式)
      const contentString = params.content || JSON.stringify({
        instId: params.instId || 'BTC-USDT',
        side: params.side || 'Long',
        entry: params.entry || '95000',
        target: params.target || '100000',
        stopLoss: params.stopLoss || '93000',
        expireHours: parseInt(params.expireHours || '24'),
        leverage: params.leverage || '1x',
        confidence: params.confidence || 'medium',
        notes: params.notes || ''
      });
      
      // Trusted Score:  计算Trusted score
      const proofData = proofResult.proof?.attestation?.data ? (typeof proofResult.proof.attestation.data === 'string' ? JSON.parse(proofResult.proof.attestation.data) : proofResult.proof.attestation.data) : {};
      const scoreResult = this.trustedScore.calculateScore(proofData, params.instId || 'BTC-USDT');
      
      
      console.log('\n🔐 zkTLS Proof 数据:');
      console.log('   recentPnl:', proofData.recentPnl || 'N/A');
      console.log('   totalEq:', proofData.totalEq || 'N/A');
      console.log('   kycLv:', proofData.kycLv || 'N/A');
      console.log('   acctLv:', proofData.acctLv || 'N/A');
      console.log('\nTrusted Score:  信号Trusted score:');
      console.log('   总分: ', scoreResult.score, '-', scoreResult.level);
      console.log('   Breakdown: ', this.trustedScore.formatScore(scoreResult.score, scoreResult.breakdown));
      
      const priceOKB = ethers.parseEther(params.price || '0.01');
      const expireHours = parseInt(params.expireHours || '24');
      const publishTxHash = ethers.ZeroHash; // 占位符，实际哈希在交易发送后更新
      
      console.log('   Signal  Chain上 Meta-data:');
      console.log(`     Currency: ${publicMeta.instId}`);
      console.log(`     有效Time: ${publicMeta.expireHours} hours`);
      console.log(`     Price: ${publicMeta.priceOKB} OKB`);
      console.log('    本地 Content:');
      console.log(`     ${contentString.substring(0, 100)}...`);
      
      console.log('\n    Attestation 详情:');
      console.log('     recipient:', proofResult.proof.attestation.recipient);
      console.log('     timestamp:', proofResult.proof.attestation.timestamp);
      console.log('     data:', proofResult.proof.attestation.data?.substring(0, 100) + '...');
      console.log('     attestors:', proofResult.proof.attestation.attestors?.length || 0);
      console.log('     signatures:', proofResult.proof.attestation.signatures?.length || 0);
      if (proofResult.proof.attestation.signatures && proofResult.proof.attestation.signatures.length > 0) {
        const sig = proofResult.proof.attestation.signatures[0];
        console.log('     签名[0]:', sig);
        console.log('     签名 [0] 长度:', sig?.length || 0);
      }
      console.log('     完整 attestation:', JSON.stringify(proofResult.proof.attestation, null, 2).substring(0, 1500) + '...');
      
      console.log('\n   发送交易...');
      
      // 获取当前 gas Price并增加 20%
      const feeData = await this.provider.getFeeData();
      const maxFeePerGas = (feeData.maxFeePerGas * 12n) / 10n; // +20%
      const maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas * 12n) / 10n;
      
      // 获取 next signalId
      const nextSignalId = await this.signalMarket.nextSignalId();
      
      // estimate gas 用量并增加 20% 缓冲
      const estimatedGas = await this.signalMarket.connect(this.providerWallet).publishSignal.estimateGas(
        scoreResult.score,    // uint256 trustedScore
        nextSignalId,         // uint256 signalId
        metaContent,          // string metaContent
        priceOKB,             // uint256 priceOKB
        expireHours,          // uint256 expireHours
        proofResult.proof.attestation, // tuple attestation
        publishTxHash         // bytes32 publishTxHash
      );
      const gasLimit = (estimatedGas * 12n) / 10n; // +20% 缓冲
      
      console.log('   Gas estimate:', estimatedGas.toString());
      console.log('   Gas Limit:', gasLimit.toString());
      
      const tx = await this.signalMarket.connect(this.providerWallet).publishSignal(
        scoreResult.score,    // uint256 trustedScore
        nextSignalId,         // uint256 signalId
        metaContent,          // string metaContent
        priceOKB,             // uint256 priceOKB
        expireHours,          // uint256 expireHours
        proofResult.proof.attestation, // tuple attestation
        publishTxHash,        // bytes32 publishTxHash
        {
          maxFeePerGas,
          maxPriorityFeePerGas,
          gasLimit
        }
      );
      
      console.log('   交易: ' + tx.hash);
      console.log('   Gas Price: ' + ethers.formatUnits(maxFeePerGas, 'gwei') + ' gwei');
      console.log('   等待确认 (最多 120 秒)...');
      
      // 添加超时处理，但超时后检查交易是否上Chain
      let receipt;
      try {
        receipt = await Promise.race([
          tx.wait(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('timeout')), 120000)
          )
        ]);
      } catch (e) {
        if (e.message === 'timeout') {
          // 超时后检查交易是否已上Chain
          console.log('    超时，检查交易Status...');
          const checkReceipt = await this.provider.getTransactionReceipt(tx.hash);
          if (checkReceipt && checkReceipt.status === 1) {
            console.log('    交易已确认(超时后)');
            receipt = checkReceipt;
          } else {
            throw new Error('交易确认超时，请检查: ' + tx.hash);
          }
        } else {
          console.error('   Error:  确认Failed:', e.message);
          throw e;
        }
      }
      
      //  使用真实的交易哈希更新Local storage
      const realPublishTxHash = tx.hash;
      
      //  通过 nextSignalId - 1 获取刚Published的信号 ID
      const nextId = await this.signalMarket.nextSignalId();
      const signalId = (nextId - 1n).toString();
      
      console.log('   Signal  Signal ID: ' + signalId);
      console.log('   Tx:  Publish transaction: ' + tx.hash);
      console.log('   🆔 Proof ID: 0x' + Buffer.from(proofResult.proof.attestation.data).toString('hex').substring(0, 64));
      
      //  保存完整信息(包括真实 tx.hash)到Local storage
      this.signalStore.saveFullSignal(signalId, contentString, tx.hash);
      
      console.log('\n 信号PublishedSuccessful！');
      console.log('   Signal  Signal ID:', signalId);
      console.log('   Trusted Score:  Trusted score: ', scoreResult.score, '-', scoreResult.level);
      console.log('   Chain上: Currency + 有效Time + zkTLS Proof');
      console.log('   本地: Full content字符串');
      console.log('   Publish transaction: ', tx.hash);
      
      return {
        success: true,
        message: ` 信号PublishedSuccessful！\n\nSignal  Signal #${signalId}\n- Currency: ${publicMeta.instId}\n- 有效Time: ${publicMeta.expireHours} hours\n- Price: ${parseFloat(ethers.formatEther(priceOKB))} OKB\n\nTrusted Score:  Trusted score: ${scoreResult.score} 分 - ${scoreResult.level}\n   Breakdown: ${this.trustedScore.formatScore(scoreResult.score, scoreResult.breakdown)}\n\n zkTLS Proof已上Chain\nTx:  Publish transaction: ${tx.hash}\n\n 完整细节已本地保存\n📨 用户购买后通过 XMTP 发送`,
        data: { signalId, publishTxHash: tx.hash, proofId: proofResult.proof.attestation.data, trustedScore: scoreResult }
      };
      
    } catch (e) {
      console.error('\nError:  PublishedFailed:', e.message);
      return { success: false, message: 'Error:  PublishedFailed: ' + e.message.substring(0, 200) };
    }
  }
  
  async chat(message) {
    const prompt = `分析用户意图，返回 JSON: 
{"intent":"config_status|config_set|config_show|list_signals|check_reputation|get_balance|check_portfolio|get_token_price|get_token_kline|get_wallet_pnl|get_smartmoney_signals|get_leaderboard|publish_signal|buy_signal|view_signal|deliver_signal|rate_signal|decrypt_signal|greeting|other","params":{},"reply":"简短中文回复"}

Configuration相关:
- "检查Configuration" → {"intent":"config_status","reply":"Checking configuration..."}
- "查看Configuration" → {"intent":"config_show","reply":"Viewing configuration..."}

功能相关:
- "有哪些信号" → {"intent":"list_signals","reply":"Querying..."}
- "买第 2  signals" → {"intent":"buy_signal","reply":"Purchasing...","params":{"signalId":2}}
- "Published一个 BTC 信号" → {"intent":"publish_signal","reply":"Publishing...","params":{"instId":"BTC-USDT"}}
- "查看信号 1" → {"intent":"view_signal","reply":"Viewing...","params":{"signalId":1}}
- "信誉" → {"intent":"check_reputation","reply":"Querying..."}
- "OKB Balance" → {"intent":"get_balance","reply":"Querying..."}

Wallet portfolio query (OKX Portfolio):
- "查看我的资产" → {"intent":"check_portfolio","reply":"Querying钱包组合..."}
- "查一下这个Address的资产 0xAbC...123" → {"intent":"check_portfolio","reply":"Querying...","params":{"address":"0xAbC...123"}}

代币Price查询 (OKX DEX Market):
- "BTC Price" → {"intent":"get_token_price","reply":"QueryingPrice...","params":{"token":"BTC"}}
- "ETH How much" → {"intent":"get_token_price","reply":"QueryingPrice...","params":{"token":"ETH"}}
- "SOL 1 hours K 线" → {"intent":"get_token_kline","reply":"Querying K 线...","params":{"token":"SOL","interval":"1h"}}
- "我的盈亏" → {"intent":"get_wallet_pnl","reply":"Querying盈亏..."}

Whale信号/Smart Money (OKX DEX Signal):
- "Whale在买什么" → {"intent":"get_smartmoney_signals","reply":"QueryingWhale信号...","params":{"walletType":"3"}}
- "Smart Money信号" → {"intent":"get_smartmoney_signals","reply":"QueryingSmart Money...","params":{"walletType":"1"}}
- "KOL 在买什么" → {"intent":"get_smartmoney_signals","reply":"Querying KOL...","params":{"walletType":"2"}}
- "Whale信号" → {"intent":"get_smartmoney_signals","reply":"QueryingWhale信号..."}
- "Solana Whale在买什么" → {"intent":"get_smartmoney_signals","reply":"Querying...","params":{"chain":"solana","walletType":"3"}}

Trader leaderboard (OKX DEX Signal Leaderboard):
- "牛人榜" → {"intent":"get_leaderboard","reply":"Querying排行榜..."}
- "Trader leaderboard" → {"intent":"get_leaderboard","reply":"Querying排行榜..."}
- "Solana Win rate最高" → {"intent":"get_leaderboard","reply":"Querying...","params":{"chain":"solana","sortBy":"2"}}
- "PnL 排行榜" → {"intent":"get_leaderboard","reply":"Querying...","params":{"sortBy":"1"}}
- "顶级交易员" → {"intent":"get_leaderboard","reply":"Querying..."}

问候:
- "hello" → {"intent":"greeting","reply":"你好！😊"}
- "你好" → {"intent":"greeting","reply":"你好呀！👋"}

用户: "${message}"

返回 JSON:`;

    try {
      console.log('[chat] Calling LLM...');
      const response = await httpPost(this.llmBaseUrl, { model: this.llmModel, input: { messages: [{ role: 'user', content: prompt }] } }, { 'Authorization': `Bearer ${this.llmApiKey}` });
      console.log('[chat] LLM response:', JSON.stringify(response).substring(0, 200));
      
      const content = response.output?.text || '{}';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const intent = jsonMatch ? JSON.parse(jsonMatch[0]) : { intent: 'other', reply: '我不太明白~' };
      console.log('[chat] Parsed intent:', intent);
      
      if (intent.intent === 'config_status') return await this.manageConfig('status');
      else if (intent.intent === 'config_show') return await this.manageConfig('show');
      else if (intent.intent === 'config_set') return await this.manageConfig('set', intent.params);
      
      if (intent.intent === 'list_signals') {
        const result = await this.listSignals();
        return { reply: intent.reply + '\n\n' + result };
      } else if (intent.intent === 'check_reputation') {
        const result = await this.checkReputation();
        return { reply: intent.reply + '\n\n' + result };
      } else if (intent.intent === 'get_balance') {
        const result = await this.getWalletBalance();
        return { reply: intent.reply + '\n\n' + result };
      } else if (intent.intent === 'check_portfolio') {
        const result = await this.checkWalletPortfolio(intent.params || {});
        return { reply: intent.reply + '\n\n' + result.reply };
      } else if (intent.intent === 'get_token_price') {
        const result = await this.getTokenPrice(intent.params || {});
        return { reply: intent.reply + '\n\n' + result.reply };
      } else if (intent.intent === 'get_token_kline') {
        const result = await this.getTokenKline(intent.params || {});
        return { reply: intent.reply + '\n\n' + result.reply };
      } else if (intent.intent === 'get_wallet_pnl') {
        const result = await this.getWalletPnL(intent.params || {});
        return { reply: intent.reply + '\n\n' + result.reply };
      } else if (intent.intent === 'get_smartmoney_signals') {
        const result = await this.getSmartMoneySignals(intent.params || {});
        return { reply: intent.reply + '\n\n' + result.reply };
      } else if (intent.intent === 'get_leaderboard') {
        const result = await this.getLeaderboard(intent.params || {});
        return { reply: intent.reply + '\n\n' + result.reply };
      } else if (intent.intent === 'buy_signal') {
        const result = await this.buySignal(intent.params || { signalId: 1 });
        return { reply: result.message };
      } else if (intent.intent === 'view_signal') {
        const result = await this.viewSignal(intent.params || { signalId: 1 });
        return { reply: result.message };
      } else if (intent.intent === 'decrypt_signal') {
        const result = await this.decryptSignal(intent.params || { signalId: 1 });
        return { reply: result.message };
      } else if (intent.intent === 'publish_signal') {
        const result = await this.publishSignal(intent.params || {});
        return { reply: result.message };
      } else if (intent.intent === 'deliver_signal') {
        const result = await this.deliverSignal(intent.params || {});
        return { reply: result.message };
      } else if (intent.intent === 'rate_signal') {
        const result = await this.submitRating(intent.params || {});
        return { reply: result.message };
      } else if (intent.intent === 'greeting') {
        return { reply: intent.reply };
      }
      
      return { reply: intent.reply || '好的' };
    } catch (e) {
      return { reply: 'Error: ' + e.message.substring(0, 100) };
    }
  }
}

export default ToolAgent;
