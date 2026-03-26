/**
 * OKX DEX Market MCP 客户端
 * 通过 MCP 协议调用 onchainos market 工具
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export class OkxDexMCP {
  constructor() {
    this.client = null;
    this.transport = null;
    this.connected = false;
  }

  async connect() {
    if (this.connected) return true;

    try {
      console.log('[OKX MCP] Connecting...');

      const env = {
        ...process.env,
        HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || 'http://127.0.0.1:8118',
        HTTP_PROXY: process.env.HTTP_PROXY || process.env.http_proxy || 'http://127.0.0.1:8118'
      };

      this.transport = new StdioClientTransport({
        command: 'onchainos',
        args: ['mcp'],
        env: env
      });

      this.client = new Client({ name: 'signal-agent', version: '0.2.0' });
      await this.client.connect(this.transport);
      this.connected = true;

      console.log('[OKX MCP] ✅ Connected');
      return true;
    } catch (e) {
      console.error('[OKX MCP] ❌ Connection failed:', e.message);
      this.connected = false;
      return false;
    }
  }

  /**
   * 查询代币价格（自动搜索代币并获取价格）
   */
  async getTokenPrice(token, chain = 'all') {
    try {
      if (!this.connected) await this.connect();

      console.log('[OKX MCP] Query price:', token, chain);

      // 1. 如果是合约地址，直接查询
      if (token.startsWith('0x') || token.startsWith('Q')) {
        return await this.callTool('market_price', {
          address: token,
          chain: chain
        });
      }

      // 2. 如果是代币符号，先搜索
      console.log('[OKX MCP] Searching token:', token);
      
      const searchResult = await this.callTool('token_search', {
        query: token,
        chain: chain
      });

      if (!searchResult.success || !searchResult.data?.content?.[0]?.text) {
        return { success: false, message: '代币搜索失败' };
      }

      const tokens = JSON.parse(searchResult.data.content[0].text);
      
      if (!tokens || tokens.length === 0) {
        return { success: false, message: `未找到代币：${token}` };
      }

      // 优先选择 Ethereum 主网或第一个结果
      const ethToken = tokens.find(t => t.chainIndex === '1');
      const selectedToken = ethToken || tokens[0];

      console.log('[OKX MCP] Found:', selectedToken.symbol, selectedToken.tokenContractAddress, selectedToken.chainIndex);

      // 3. 查询价格
      return await this.callTool('market_price', {
        address: selectedToken.tokenContractAddress,
        chain: selectedToken.chainIndex
      });

    } catch (e) {
      console.error('[OKX MCP] Price query failed:', e.message);
      return { success: false, message: e.message };
    }
  }

  /**
   * 查询 K 线
   */
  async getTokenKline(token, interval = '1H', chain = 'all', limit = 24) {
    try {
      if (!this.connected) await this.connect();

      // 获取合约地址
      let address = token;
      let tokenChain = chain;

      if (!token.startsWith('0x') && !token.startsWith('Q')) {
        const searchResult = await this.callTool('token_search', {
          query: token,
          chain: chain
        });

        if (searchResult.success && searchResult.data?.content?.[0]?.text) {
          const tokens = JSON.parse(searchResult.data.content[0].text);
          if (tokens && tokens.length > 0) {
            const ethToken = tokens.find(t => t.chainIndex === '1');
            const selectedToken = ethToken || tokens[0];
            address = selectedToken.tokenContractAddress;
            tokenChain = selectedToken.chainIndex;
          }
        }
      }

      return await this.callTool('market_kline', {
        address: address,
        chain: tokenChain,
        bar: interval,
        limit: limit
      });

    } catch (e) {
      console.error('[OKX MCP] Kline query failed:', e.message);
      return { success: false, message: e.message };
    }
  }

  /**
   * 查询钱包 PnL
   */
  async getWalletPnL(address, chain = 'all') {
    if (!this.connected) await this.connect();
    return await this.callTool('market_portfolio_overview', { address, chain });
  }

  /**
   * 查询聪明钱交易信号
   */
  async getSmartMoneySignals(chain = 'all', walletType, minAmountUsd, limit = 10) {
    try {
      if (!this.connected) await this.connect();

      console.log('[OKX MCP] Querying signals:', chain, walletType);

      const args = { chain, limit };
      if (walletType) args.walletType = walletType;
      if (minAmountUsd) args.minAmountUsd = minAmountUsd;

      return await this.callTool('signal_list', args);

    } catch (e) {
      console.error('[OKX MCP] Signal query failed:', e.message);
      return { success: false, message: e.message };
    }
  }

  /**
   * 获取支持的信号链
   */
  async getSignalChains() {
    if (!this.connected) await this.connect();
    return await this.callTool('signal_chains', {});
  }

  /**
   * 查询交易员排行榜
   */
  async getLeaderboard(chain = 'solana', timeFrame = 3, sortBy = 1, walletType, minTxs, limit = 20) {
    try {
      if (!this.connected) await this.connect();

      console.log('[OKX MCP] Querying leaderboard:', chain, timeFrame, sortBy);

      const args = { chain, timeFrame, sortBy, limit };
      if (walletType) args.walletType = walletType;
      if (minTxs) args.minTxs = minTxs;

      return await this.callTool('leaderboard_list', args);

    } catch (e) {
      console.error('[OKX MCP] Leaderboard query failed:', e.message);
      return { success: false, message: e.message };
    }
  }

  /**
   * 获取支持的排行榜链
   */
  async getLeaderboardChains() {
    if (!this.connected) await this.connect();
    return await this.callTool('leaderboard_supported_chains', {});
  }

  /**
   * 直接调用 MCP 工具
   */
  async callTool(toolName, args) {
    try {
      if (!this.connected) await this.connect();

      console.log(`[OKX MCP] Calling ${toolName}:`, args);

      const result = await this.client.callTool({
        name: toolName,
        arguments: args
      });

      return { success: true, data: result };

    } catch (e) {
      console.error(`[OKX MCP] ${toolName} failed:`, e.message);
      return { success: false, message: e.message };
    }
  }

  async disconnect() {
    if (this.transport) await this.transport.close();
    this.client = null;
    this.connected = false;
  }
}

export default OkxDexMCP;
