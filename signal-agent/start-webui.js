import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { ethers } from 'ethers';
import fs from 'fs';
import { ToolAgent } from './src/toolAgent.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 使用绝对路径加载 .env 文件
const envPath = path.resolve(__dirname, '.env');
dotenv.config({ path: envPath, override: true });

const fastify = Fastify({ logger: false });

fastify.register(cors, { origin: '*' });

console.log('\n🚀 启动 Signal Market Web UI (Wallet signature mode)...\n');

const provider = new ethers.JsonRpcProvider(process.env.XLAYER_RPC_URL || 'https://testrpc.xlayer.tech/terigon');

const agentRegistryABI = [
  'function isRegistered(address) view returns (bool)',
  'function registerAgent(string name) external',
  'function getAgent(address) view returns (tuple(string name, address walletAddress, bytes32 latestProofId, uint256 reputationScore, uint256 totalRatings, bool active, uint256 registeredAt))',
  'function getReputation(address) view returns (uint256, uint256)'
];

const signalMarketABI = [
  'function nextSignalId() view returns (uint256)',
  'function getSignal(uint256) view returns (tuple(uint256 signalId, address providerAddress, uint256 publishTime, bytes32 publishTxHash, string metaContent, uint256 priceOKB, uint256 expireTime, bytes32 proofId, uint256 trustedScore, bool active))',
  'function purchaseSignal(uint256 signalId, string calldata buyerPublicKey) external payable returns (uint256)',
  'function recordDelivery(uint256 purchaseId, string calldata encryptedContent) external',
  'function publishSignal(uint256 trustedScore, uint256 signalId, string metaContent, uint256 priceOKB, uint256 expireHours, tuple(address recipient, tuple(string url, string header, string method, string body) request, tuple(string keyName, string parseType, string parsePath)[] reponseResolve, string data, string attConditions, uint64 timestamp, string additionParams, tuple(address attestorAddr, string url)[] attestors, bytes[] signatures) attestation, bytes32 publishTxHash) external returns (uint256)',
  'event SignalPublished(uint256 indexed signalId, address indexed providerAddress, uint256 publishTime, uint256 priceOKB, uint256 expireTime)'
];

const agentRegistry = new ethers.Contract(process.env.AGENT_REGISTRY_ADDRESS, agentRegistryABI, provider);
const signalMarket = new ethers.Contract(process.env.SIGNAL_MARKET_ADDRESS, signalMarketABI, provider);

// 初始化 ToolAgent(自然语言处理)
const toolAgent = new ToolAgent({
  rpcUrl: process.env.XLAYER_RPC_URL || 'https://testrpc.xlayer.tech/terigon',
  providerPrivateKey: process.env.PROVIDER_PRIVATE_KEY,
  consumerPrivateKey: process.env.CONSUMER_PRIVATE_KEY,
  llmApiKey: process.env.LLM_API_KEY,
  llmModel: process.env.LLM_MODEL || 'qwen-plus',
  primusAppId: process.env.PRIMUS_APP_ID,
  primusAppSecret: process.env.PRIMUS_APP_SECRET,
  signalMarketAddress: process.env.SIGNAL_MARKET_ADDRESS,
  agentRegistryAddress: process.env.AGENT_REGISTRY_ADDRESS,
  okxApiKey: process.env.OKX_API_KEY,
  okxSecretKey: process.env.OKX_SECRET_KEY,
  okxPassphrase: process.env.OKX_PASSPHRASE
});
console.log('✅ ToolAgent Initialized(Natural language interaction)');

fastify.register(fastifyStatic, { root: path.join(__dirname, 'public') });

// API: 检查钱包注册状态
fastify.get('/api/registration-status/:address', async (request, reply) => {
  try {
    const { address } = request.params;
    const isRegistered = await agentRegistry.isRegistered(address);
    
    if (isRegistered) {
      const agentData = await agentRegistry.getAgent(address);
      return { 
        registered: true, 
        name: agentData.name,
        active: agentData.active,
        reputationScore: agentData.reputationScore.toString(),
        totalRatings: agentData.totalRatings.toString()
      };
    }
    return { registered: false };
  } catch (e) {
    console.error('Registration check error:', e.message);
    return { registered: false, error: e.message };
  }
});

// API: 注册 Agent (返回交易数据，前端签名)
fastify.post('/api/register', async (request, reply) => {
  try {
    const { name, from } = request.body;
    
    const tx = await agentRegistry.registerAgent.populateTransaction(name || 'Agent');
    
    const feeData = await provider.getFeeData();
    const defaultGasPrice = ethers.parseUnits('20', 'gwei');
    const gasPrice = feeData.gasPrice || feeData.maxFeePerGas || defaultGasPrice;
    
    console.log('[Register] Gas price:', gasPrice.toString());
    
    // 转换 BigInt 为 string，避免序列化错误
    return { 
      success: true, 
      tx: {
        to: await agentRegistry.getAddress(),
        from: from,
        data: tx.data,
        value: '0x0',
        chainId: '0x7a0',
        gasLimit: '0x927c0',  // 600,000 in hex
        gasPrice: '0x' + gasPrice.toString(16)
      }
    };
  } catch (e) {
    console.error('Register error:', e.message);
    return { success: false, message: e.message };
  }
});

// API: 信号列表
fastify.get('/api/signals', async (request, reply) => {
  try {
    const signals = [];
    
    // 通过事件日志查询所有信号(分批查询，每批 100 区块)
    const currentBlock = await provider.getBlockNumber();
    const batchSize = 100;
    const fromBlock = Math.max(0, currentBlock - 10000);
    
    // SignalPublished 事件 topic(5 个参数版本，匹配链上合约)
    const signalPublishedTopic = '0x1c0a5b2c2d0168fbe82a6d97c9fbcfba5b3ac848280ee109438c0e569a657911';
    
    console.log('[/api/signals] Querying events from block', fromBlock, 'to', currentBlock);
    
    for (let batchStart = fromBlock; batchStart <= currentBlock; batchStart += batchSize) {
      const batchEnd = Math.min(batchStart + batchSize - 1, currentBlock);
      try {
        const logs = await provider.getLogs({
          address: process.env.SIGNAL_MARKET_ADDRESS,
          fromBlock: batchStart,
          toBlock: batchEnd,
          topics: [signalPublishedTopic]
        });
        
        for (const log of logs) {
          try {
            const signalId = BigInt(log.topics[1]);
            const signal = await signalMarket.getSignal(signalId);
            const meta = JSON.parse(signal.metaContent);
            
            signals.push({
              signalId: signalId.toString(),
              providerAddress: signal.providerAddress,
              meta: {
                instId: meta.instId || 'UNKNOWN',
                expireHours: meta.expireHours || '24',
                priceOKB: meta.priceOKB || parseFloat(ethers.formatEther(signal.priceOKB))
              },
              priceOKB: parseFloat(ethers.formatEther(signal.priceOKB)),
              publishTxHash: 'N/A',
              active: signal.active,
              trustedScore: signal.trustedScore ? signal.trustedScore.toString() : '0'
            });
          } catch (e) {
            console.error('[/api/signals] Error processing event:', e.message);
          }
        }
      } catch (e) {
        console.error('[/api/signals] Error querying batch:', batchStart, '-', batchEnd, e.message);
      }
    }
    
    console.log('[/api/signals] Found', signals.length, 'signals');
    return { signals };
  } catch (e) {
    console.error('[/api/signals] Error:', e.message);
    return { signals: [], error: e.message };
  }
});

// API: 配置状态
fastify.get('/api/config-status', async (request, reply) => {
  try {
    const hasOkxApi = !!(process.env.OKX_API_KEY && process.env.OKX_SECRET_KEY && process.env.OKX_PASSPHRASE);
    const hasLlm = !!process.env.LLM_API_KEY;
    
    return {
      allConfigured: hasOkxApi && hasLlm,
      items: [
        { name: 'OKX Developer API', configured: hasOkxApi },
        { name: 'LLM Setting', configured: hasLlm }
      ]
    };
  } catch (e) {
    return { allConfigured: false, items: [] };
  }
});

// API: 发布信号 (返回交易数据)
fastify.post('/api/publish', async (request, reply) => {
  try {
    const { instId, price, expireHours, from, attestation, publishTxHash, content, encryptContent } = request.body;
    
    if (!attestation) {
      return { success: false, message: 'Missing attestation. Please generate zkTLS proof first.' };
    }
    
    if (!publishTxHash) {
      return { success: false, message: 'Missing publishTxHash.' };
    }
    
    const publicMeta = {
      instId: instId || 'BTC-USDT',
      expireHours: parseInt(expireHours || '24'),
      priceOKB: parseFloat(price || '0.01')
    };
    
    const metaContent = JSON.stringify(publicMeta);
    
    // 使用前端传入的 content，如果没有则使用默认值
    const contentString = content || JSON.stringify({
      instId: instId || 'BTC-USDT',
      signal: '看涨/看跌信号详情',
      targetPrice: '目标价格',
      stopLoss: '止损价格',
      analysis: '详细分析内容...'
    });
    
    console.log('[Publish] Content to save:', contentString.substring(0, 100) + '...');
    
    const priceOKB = ethers.parseEther(price || '0.01');
    const expireHoursNum = parseInt(expireHours || '24');
    
    // 生成唯一 signalId: hash(wallet + timestamp)
    const timestamp = Date.now();
    const uniqueInput = from.toLowerCase() + timestamp.toString();
    const signalIdHex = ethers.keccak256(ethers.toUtf8Bytes(uniqueInput)).substring(2, 10); // 8 字符 hex
    const signalId = BigInt('0x' + signalIdHex); // 转换为 uint256
    
    // Trusted Score: 默认值 0 (简化处理，实际应该计算)
    const trustedScore = 0;
    
    console.log('[Publish] Generated signalId:', signalIdHex, 'from:', from, 'timestamp:', timestamp);
    
    // 保存到本地 agent-session 目录
    const { SignalStore } = await import('./src/signalStore.js');
    const signalStore = new SignalStore(from);
    
    signalStore.saveFullSignal(signalIdHex, contentString, publishTxHash);
    console.log('[Publish] Signal saved to agent-session:', from);
    
    // 使用真实的 attestation、signalId 和 tx hash
    const tx = await signalMarket.publishSignal.populateTransaction(
      trustedScore,      // uint256 trustedScore
      signalId,          // uint256 signalId
      metaContent,       // string metaContent
      priceOKB,          // uint256 priceOKB
      expireHoursNum,    // uint256 expireHours
      attestation,       // tuple attestation
      publishTxHash      // bytes32 publishTxHash
    );
    
    tx.from = from;
    tx.chainId = 1952;
    // 验证 zkTLS 签名需要较多 gas，但不超过 800,000
    tx.gasLimit = 800000n;
    
    const feeData = await provider.getFeeData();
    // X Layer 使用传统 gasPrice，不使用 EIP-1559
    // 提供默认值: 0.1 Gwei = 100000000 wei
    const defaultGasPrice = ethers.parseUnits('0.1', 'gwei');
    tx.gasPrice = feeData.gasPrice || feeData.maxFeePerGas || defaultGasPrice;
    console.log('[Publish] Using gasPrice:', tx.gasPrice.toString());
    
    // 转换 BigInt 为 string，避免序列化错误
    return { 
      success: true, 
      tx: {
        to: tx.to,
        from: tx.from,
        data: tx.data,
        value: tx.value?.toString() || '0',
        chainId: tx.chainId,
        gasLimit: tx.gasLimit?.toString(),
        gasPrice: tx.gasPrice.toString()
      },
      signalId: signalIdHex  // 返回 signalId 给前端
    };
  } catch (e) {
    console.error('Publish error:', e.message);
    return { success: false, message: e.message };
  }
});

// API: 广播交易
fastify.post('/api/broadcast', async (request, reply) => {
  try {
    const { signedTx } = request.body;
    const txResponse = await provider.broadcastTransaction(signedTx);
    
    return { success: true, hash: txResponse.hash };
  } catch (e) {
    console.error('Broadcast error:', e.message);
    return { success: false, message: e.message };
  }
});

// API: 查询交易状态
fastify.get('/api/tx/:hash', async (request, reply) => {
  try {
    const { hash } = request.params;
    const receipt = await provider.getTransactionReceipt(hash);
    
    if (receipt) {
      return { 
        confirmed: true, 
        status: receipt.status === 1 ? 1 : 0,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString()
      };
    }
    
    // 交易还在 pending 中
    const tx = await provider.getTransaction(hash);
    if (tx) {
      return { confirmed: false, pending: true };
    }
    
    return { confirmed: false, notFound: true };
  } catch (e) {
    console.error('Tx status error:', e.message);
    return { confirmed: false, error: e.message };
  }
});

// API: 获取钱包余额
fastify.get('/api/balance/:address', async (request, reply) => {
  try {
    const { address } = request.params;
    const balance = await provider.getBalance(address);
    return { balance: ethers.formatEther(balance) };
  } catch (e) {
    return { error: e.message };
  }
});

// API: 自然语言聊天
fastify.post('/api/chat', async (request, reply) => {
  try {
    const { message } = request.body;
    
    if (!message) {
      return { reply: '请输入消息' };
    }
    
    const result = await toolAgent.chat(message);
    return { reply: result.reply || '我不太明白~' };
  } catch (e) {
    console.error('Chat error:', e.message);
    return { reply: '错误: ' + e.message.substring(0, 100) };
  }
});

// API: 注册公钥(一次性操作)
fastify.post('/api/register-public-key', async (request, reply) => {
  try {
    const { from } = request.body;
    
    if (!from) {
      return { success: false, message: 'Missing from address' };
    }
    
    const publicKeyRegistryAddress = process.env.PUBLIC_KEY_REGISTRY;
    if (!publicKeyRegistryAddress) {
      return { success: false, message: 'PUBLIC_KEY_REGISTRY not configured' };
    }
    
    // 从私钥推导公钥
    const consumerPrivateKey = process.env.CONSUMER_PRIVATE_KEY;
    if (!consumerPrivateKey) {
      return { success: false, message: 'CONSUMER_PRIVATE_KEY not configured' };
    }
    
    // ECIES 公钥 = 私钥去掉 0x 前缀(简化处理，实际应该从私钥推导)
    const publicKey = consumerPrivateKey.slice(2).padStart(128, '0');
    
    const publicKeyRegistry = new ethers.Contract(
      publicKeyRegistryAddress,
      ['function registerPublicKey(string calldata publicKey) external'],
      provider
    );
    
    const tx = await publicKeyRegistry.registerPublicKey.populateTransaction(publicKey);
    tx.from = from;
    tx.chainId = 1952;
    tx.gasLimit = 100000n;
    
    const feeData = await provider.getFeeData();
    const defaultGasPrice = ethers.parseUnits('2', 'gwei');
    tx.gasPrice = feeData.gasPrice || feeData.maxFeePerGas || defaultGasPrice;
    
    return {
      success: true,
      tx: {
        to: tx.to,
        from: tx.from,
        data: tx.data,
        value: '0',
        chainId: tx.chainId,
        gasLimit: tx.gasLimit?.toString(),
        gasPrice: tx.gasPrice.toString()
      },
      publicKey
    };
  } catch (e) {
    console.error('[Register Public Key] Error:', e.message);
    return { success: false, message: e.message };
  }
});

// API: 检查公钥是否已注册
fastify.get('/api/public-key-status/:address', async (request, reply) => {
  try {
    const { address } = request.params;
    const publicKeyRegistryAddress = process.env.PUBLIC_KEY_REGISTRY;
    
    if (!publicKeyRegistryAddress) {
      return { success: false, message: 'PUBLIC_KEY_REGISTRY not configured' };
    }
    
    const publicKeyRegistry = new ethers.Contract(
      publicKeyRegistryAddress,
      ['function isRegistered(address) view returns (bool)', 'function getPublicKey(address) view returns (string)'],
      provider
    );
    
    const isRegistered = await publicKeyRegistry.isRegistered(address);
    let publicKey = null;
    
    if (isRegistered) {
      publicKey = await publicKeyRegistry.getPublicKey(address);
    }
    
    return {
      success: true,
      isRegistered,
      publicKey
    };
  } catch (e) {
    console.error('[Public Key Status] Error:', e.message);
    return { success: false, message: e.message };
  }
});

// API: 准备购买信号(返回交易数据)
fastify.post('/api/buy-prepare', async (request, reply) => {
  try {
    const { signalId, from, buyerPublicKey } = request.body;
    
    if (signalId === undefined || signalId === null || signalId === '') {
      return { success: false, message: 'Missing signalId' };
    }
    
    if (!buyerPublicKey || buyerPublicKey.length !== 128) {
      return { success: false, message: 'Invalid buyerPublicKey (must be 128 characters)' };
    }
    
    console.log('[Buy Prepare] Getting signal info for:', signalId);
    console.log('[Buy Prepare] Buyer:', from);
    console.log('[Buy Prepare] Buyer Public Key:', buyerPublicKey.substring(0, 16) + '...');
    
    // 获取信号信息
    const signal = await signalMarket.getSignal(signalId);
    const publicMeta = JSON.parse(signal.metaContent);
    
    // 构建交易 - 调用 SignalMarket.purchaseSignal
    const tx = await signalMarket.purchaseSignal.populateTransaction(
      signalId,
      buyerPublicKey
    );
    
    tx.from = from;
    tx.chainId = 1952;
    tx.gasLimit = 500000n;
    tx.value = signal.priceOKB;
    
    const feeData = await provider.getFeeData();
    const defaultGasPrice = ethers.parseUnits('2', 'gwei');
    tx.gasPrice = feeData.gasPrice || feeData.maxFeePerGas || defaultGasPrice;
    
    console.log('[Buy Prepare] Gas price:', tx.gasPrice.toString());
    console.log('[Buy Prepare] Value:', signal.priceOKB.toString());
    
    return {
      success: true,
      tx: {
        to: tx.to,
        from: tx.from,
        data: tx.data,
        value: tx.value.toString(),
        chainId: tx.chainId,
        gasLimit: tx.gasLimit?.toString(),
        gasPrice: tx.gasPrice.toString()
      },
      signalInfo: {
        signalId: signalId.toString(),
        provider: signal.providerAddress,
        priceOKB: parseFloat(ethers.formatEther(signal.priceOKB)),
        instId: publicMeta.instId
      }
    };
  } catch (e) {
    console.error('[Buy Prepare] Error:', e.message);
    return { success: false, message: e.message };
  }
});

// API: 获取购买状态
fastify.get('/api/purchase-status/:address', async (request, reply) => {
  try {
    const { address } = request.params;
    const signalEscrowAddress = process.env.SIGNAL_ESCROW;
    
    if (!signalEscrowAddress) {
      return { success: false, message: 'SIGNAL_ESCROW not configured' };
    }
    
    const signalEscrow = new ethers.Contract(
      signalEscrowAddress,
      [
        'function getPendingDeliveries(address provider) view returns (uint256[])',
        'function getEncryptedSignals(address buyer) view returns (uint256[])'
      ],
      provider
    );
    
    // 查询作为 Provider 的待交付
    const pendingDeliveries = await signalEscrow.getPendingDeliveries(address);
    
    // 查询作为 Buyer 的待下载
    const encryptedSignals = await signalEscrow.getEncryptedSignals(address);
    
    // 过滤掉无效的 purchaseId (0)
    const validEncryptedSignals = encryptedSignals.filter(id => id > 0n);
    
    console.log('[Purchase Status] address:', address);
    console.log('[Purchase Status] encryptedSignals (raw):', encryptedSignals);
    console.log('[Purchase Status] validEncryptedSignals:', validEncryptedSignals.map(id => id.toString()));
    
    return {
      success: true,
      pendingDeliveries: pendingDeliveries.map(id => id.toString()),
      encryptedSignals: validEncryptedSignals.map(id => id.toString()),
      pendingCount: pendingDeliveries.length,
      encryptedCount: validEncryptedSignals.length
    };
  } catch (e) {
      encryptedCount: validEncryptedSignals.length
    console.error('[Purchase Status] Error:', e.message);
    return { success: false, message: e.message };
  }
});

// API: 准备交付信号(返回交易数据)
fastify.post('/api/deliver-prepare', async (request, reply) => {
  try {
    const { purchaseId, from } = request.body;
    
    if (purchaseId === undefined || purchaseId === null || purchaseId === '') {
      return { success: false, message: 'Missing purchaseId' };
    }
    
    console.log('[Deliver Prepare] Getting purchase info for:', purchaseId);
    
    // 获取购买信息
    const signalEscrowAddress = process.env.SIGNAL_ESCROW;
    const signalEscrow = new ethers.Contract(
      signalEscrowAddress,
      ['function getPurchase(uint256) view returns (uint256, address, address, uint256, string, uint256, bool, bool, bool)'],
      provider
    );
    
    const purchase = await signalEscrow.getPurchase(purchaseId);
    const signalId = purchase[0].toString();  // 链上 signalId(uint256)
    const buyer = purchase[1];
    const signalProvider = purchase[2];
    const buyerPublicKey = purchase[4];  // 从合约读取买家公钥(hex 字符串)
    const delivered = purchase[6];
    
    console.log('[Deliver Prepare] Signal ID:', signalId);
    console.log('[Deliver Prepare] Buyer:', buyer);
    console.log('[Deliver Prepare] Buyer Public Key (raw):', buyerPublicKey);
    console.log('[Deliver Prepare] Buyer Public Key type:', typeof buyerPublicKey);
    console.log('[Deliver Prepare] Buyer Public Key length:', buyerPublicKey?.length);
    
    if (delivered) {
      return { success: false, message: 'Already delivered' };
    }
    
    if (signalProvider.toLowerCase() !== from.toLowerCase()) {
      return { success: false, message: 'Not the provider of this signal' };
    }
    

    // 从 Local storage 获取信号内容 (原始内容，未加密)
    // signalId 是 uint256，需要转换为 hex 字符串查找文件
    const signalIdHex = BigInt(signalId).toString(16).padStart(8, '0').substring(0, 8);
    
    // 初始化 SignalStore
    const { SignalStore } = await import('./src/signalStore.js');
    const signalStore = new SignalStore(signalProvider);
    
    // DEBUG: 打印路径信息
    console.log('[Deliver Prepare] signalProvider:', signalProvider);
    console.log('[Deliver Prepare] signalStore.sessionDir:', signalStore.sessionDir);
    console.log('[Deliver Prepare] signalStore.signalsDir:', signalStore.signalsDir);
    console.log('[Deliver Prepare] Looking for file: signal_' + signalIdHex + '.json');
    
    // 列出目录中的所有文件
    const fs = await import('fs');
    if (fs.existsSync(signalStore.signalsDir)) {
      const files = fs.readdirSync(signalStore.signalsDir);
      console.log('[Deliver Prepare] Files in signalsDir:', files);
    } else {
      console.error('[Deliver Prepare] signalsDir does not exist:', signalStore.signalsDir);
    }
    
    const signalData = signalStore.getFullSignal(signalIdHex);
    const contentString = signalData.content;
    console.log('[Deliver Prepare] Loaded signal content from agent-session');
    console.log('[Deliver Prepare] Content length:', contentString.length);
    
    // 使用买家公钥加密
    const { eciesEncrypt } = await import('./src/ecies.js');
    console.log('[Deliver Prepare] Encrypting with buyer public key...');
    console.log('[Deliver Prepare] buyerPublicKey for encryption:', buyerPublicKey.substring(0, 32) + '...');
    const encryptedContent = await eciesEncrypt(buyerPublicKey, contentString);
    console.log('[Deliver Prepare] Encrypted content length:', encryptedContent.length);
    console.log('[Deliver Prepare] Encrypted content (hex):', encryptedContent.toString('hex').substring(0, 64) + '...');
    
    // 转换为 hex 字符串(合约要求)
    const encryptedContentHex = '0x' + encryptedContent.toString('hex');
    
    // 构建交易(提交加密内容)
    const tx = await signalMarket.recordDelivery.populateTransaction(purchaseId, encryptedContentHex);
    
    tx.from = from;
    tx.chainId = 1952;
    tx.gasLimit = 1000000n;
    
    const feeData = await provider.getFeeData();
    const defaultGasPrice = ethers.parseUnits('2', 'gwei');
    tx.gasPrice = feeData.gasPrice || feeData.maxFeePerGas || defaultGasPrice;
    
    console.log('[Deliver Prepare] Gas price:', tx.gasPrice.toString());
    console.log('[Deliver Prepare] Gas limit:', tx.gasLimit.toString());
    
    return {
      success: true,
      tx: {
        to: tx.to,
        from: tx.from,
        data: tx.data,
        value: '0',
        chainId: tx.chainId,
        gasLimit: tx.gasLimit?.toString(),
        gasPrice: tx.gasPrice.toString()
      }
    };
  } catch (e) {
    console.error('[Deliver Prepare] Error:', e);
    console.error('[Deliver Prepare] Error message:', e.message);
    console.error('[Deliver Prepare] Error code:', e.code);
    console.error('[Deliver Prepare] Error argument:', e.argument);
    console.error('[Deliver Prepare] Error value:', e.value);
    return { success: false, message: e.message };
  }
});

// API: 获取加密内容
fastify.get('/api/encrypted-content/:purchaseId', async (request, reply) => {
  try {
    const { purchaseId } = request.params;
    
    const signalEscrowAddress = process.env.SIGNAL_ESCROW;
    const signalEscrow = new ethers.Contract(
      signalEscrowAddress,
      ['function getEncryptedContent(uint256) view returns (string, uint256)'],
      provider
    );
    
    const [encryptedContent, deliverTimestamp] = await signalEscrow.getEncryptedContent(purchaseId);
    
    return {
      success: true,
      encryptedContent,
      deliverTimestamp: deliverTimestamp.toString()
    };
  } catch (e) {
    console.error('[Encrypted Content] Error:', e.message);
    return { success: false, message: e.message };
  }
});

// API: 解密信号内容(使用后端存储的私钥)
fastify.post('/api/decrypt', async (request, reply) => {
  try {
    const { purchaseId } = request.body;
    console.log('[Decrypt] Request body:', request.body);
    console.log('[Decrypt] purchaseId value:', purchaseId);
    console.log('[Decrypt] purchaseId type:', typeof purchaseId);
    
    if (!purchaseId) {
      return { success: false, message: 'Missing purchaseId' };
    }
    
    // 检查是否配置了私钥
    const consumerPrivateKey = process.env.CONSUMER_PRIVATE_KEY;
    console.log('[Decrypt] CONSUMER_PRIVATE_KEY from env:', consumerPrivateKey ? 'loaded' : 'NOT LOADED');
    console.log('[Decrypt] CONSUMER_PRIVATE_KEY length:', consumerPrivateKey?.length);
    console.log('[Decrypt] CONSUMER_PRIVATE_KEY starts with 0x:', consumerPrivateKey?.startsWith('0x'));
    
    if (!consumerPrivateKey) {
      return { success: false, message: 'CONSUMER_PRIVATE_KEY not configured in .env' };
    }
    
    // 获取加密内容
    const signalEscrowAddress = process.env.SIGNAL_ESCROW;
    const signalEscrow = new ethers.Contract(
      signalEscrowAddress,
      ['function getEncryptedContent(uint256) view returns (string, uint256)'],
      provider
    );
    
    const [encryptedContent] = await signalEscrow.getEncryptedContent(purchaseId);
    
    console.log('[Decrypt] Purchase ID:', purchaseId);
    console.log('[Decrypt] Encrypted content from chain:', encryptedContent.substring(0, 64) + '...');
    console.log('[Decrypt] Encrypted content type:', typeof encryptedContent);
    console.log('[Decrypt] Encrypted content first byte:', encryptedContent.substring(0, 4));
    
    // 解密
    const { eciesDecrypt } = await import('./src/ecies.js');
    const buyerPrivateKey = consumerPrivateKey.startsWith('0x') ? consumerPrivateKey.slice(2) : consumerPrivateKey;
    console.log('[Decrypt] Using private key length:', buyerPrivateKey.length);
    const decryptedContent = await eciesDecrypt(buyerPrivateKey, encryptedContent);
    
    return {
      success: true,
      decryptedContent
    };
  } catch (e) {
    console.error('[Decrypt] Error:', e.message);
    return { success: false, message: 'Decryption failed: ' + e.message.substring(0, 200) };
  }
});

// API: 确认交付(Buyer 确认，释放资金)
fastify.post('/api/confirm-delivery', async (request, reply) => {
  try {
    const { purchaseId, from } = request.body;
    
    const signalEscrowAddress = process.env.SIGNAL_ESCROW;
    const signalEscrow = new ethers.Contract(
      signalEscrowAddress,
      ['function confirmDelivery(uint256 purchaseId) external'],
      provider
    );
    
    const tx = await signalEscrow.confirmDelivery.populateTransaction(purchaseId);
    tx.from = from;
    tx.chainId = 1952;
    tx.gasLimit = 100000n;
    
    const feeData = await provider.getFeeData();
    const defaultGasPrice = ethers.parseUnits('0.1', 'gwei');
    tx.gasPrice = feeData.gasPrice || feeData.maxFeePerGas || defaultGasPrice;
    
    return {
      success: true,
      tx: {
        to: tx.to,
        from: tx.from,
        data: tx.data,
        value: '0',
        chainId: tx.chainId,
        gasLimit: tx.gasLimit?.toString(),
        gasPrice: tx.gasPrice.toString()
      }
    };
  } catch (e) {
    console.error('[Confirm Delivery] Error:', e.message);
    return { success: false, message: e.message };
  }
});

// API: 生成 zkTLS 证明(发布信号前必须调用)
fastify.post('/api/generate-proof', async (request, reply) => {
  try {
    const { instId, from } = request.body;
    
    if (!instId) {
      return { success: false, message: 'Please provide instId (e.g., "BTC-USDT")' };
    }
    
    console.log('[Generate Proof] Generating zkTLS proof for:', instId);
    
    // 使用 Primus zkTLS 生成证明
    const proofResult = await toolAgent.primusZkTLS.generateTradingProof(instId);
    
    if (!proofResult.success) {
      console.error('[Generate Proof] Failed:', proofResult.error);
      return { 
        success: false, 
        message: 'Failed to generate proof: ' + proofResult.error 
      };
    }
    
    console.log('[Generate Proof] Success! PnL:', proofResult.pnl);
    
    // 保存 proof 到 agent-session 目录
    if (from) {
      const { SignalStore } = await import('./src/signalStore.js');
      const signalStore = new SignalStore(from);
      const timestamp = Date.now();
      const filename = `pnl_${instId}_${timestamp}.json`;
      signalStore.saveProof(filename, {
        instId,
        pnl: proofResult.pnl,
        totalEq: proofResult.totalEq,
        kycLv: proofResult.kycLv,
        attestation: proofResult.attestation,
        timestamp
      });
    }
    
    // 返回 attestation 对象(用于合约调用)
    return {
      success: true,
      attestation: proofResult.attestation,
      pnl: proofResult.pnl,
      totalEq: proofResult.totalEq,
      kycLv: proofResult.kycLv,
      message: `✅ zkTLS proof generated successfully! PnL: ${proofResult.pnl}`
    };
  } catch (e) {
    console.error('[Generate Proof] Error:', e.message);
    return { 
      success: false, 
      message: 'Error generating proof: ' + e.message.substring(0, 200) 
    };
  }
});

const PORT = process.env.PORT || 3000;

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error('启动失败:', err);
    process.exit(1);
  }
  console.log(`\n✅ Web UI started (Wallet signature mode)`);
  console.log(`   Access: http://localhost:${PORT}`);
  console.log('');
});