/**
 * XMTP 完整集成模块
 * 
 * 整合：
 * 1. XMTP 客户端（真实协议）
 * 2. 消息持久化存储
 * 3. 自动重连和离线消息处理
 */

import { XMTPClient } from './xmtpClient.js';
import { MessageStore } from './xmtpMessageStore.js';
import { ethers } from 'ethers';

export class XMTPIntegration {
  constructor(privateKey, options = {}) {
    this.wallet = new ethers.Wallet(privateKey);
    this.address = this.wallet.address;
    this.env = options.env || 'production';
    
    // 初始化组件
    this.client = new XMTPClient(this.wallet, { env: this.env });
    this.messageStore = new MessageStore(this.address);
    
    // 状态
    this.isConnected = false;
    this.isListening = false;
    this.messageHandlers = [];
    
    console.log(`\n📡 XMTP 集成模块已初始化`);
    console.log(`   钱包地址：${this.address}`);
    console.log(`   网络：${this.env}`);
    console.log(`   消息存储：${this.messageStore.storeDir}`);
  }
  
  /**
   * 连接 XMTP 网络
   */
  async connect() {
    try {
      console.log('\n🔌 连接 XMTP...');
      
      const result = await this.client.connect();
      
      if (result.success) {
        this.isConnected = true;
        console.log(`   ✅ XMTP 连接成功`);
        
        // 处理离线消息
        await this.processOfflineMessages();
        
        return { success: true };
      } else {
        console.log(`   ❌ 连接失败：${result.error}`);
        return result;
      }
    } catch (e) {
      console.error('   ❌ 连接异常:', e.message);
      return { success: false, error: e.message };
    }
  }
  
  /**
   * 处理离线消息
   */
  async processOfflineMessages() {
    console.log('\n📬 处理离线消息...');
    
    const pendingMessages = this.messageStore.getPendingMessages();
    console.log(`   找到 ${pendingMessages.length} 条待处理消息`);
    
    for (const message of pendingMessages) {
      console.log(`   处理：${message.id}`);
      
      try {
        // 通知所有处理器
        for (const handler of this.messageHandlers) {
          await handler(message, message.content);
        }
        
        this.messageStore.markProcessed(message.id);
      } catch (e) {
        console.error(`   ❌ 处理失败：${e.message}`);
      }
    }
  }
  
  /**
   * 开始监听消息
   */
  async startListening() {
    if (!this.isConnected) {
      console.log('❌ XMTP 未连接，无法监听');
      return { success: false, error: 'XMTP 未连接' };
    }
    
    if (this.isListening) {
      console.log('⚠️  已在监听中');
      return { success: false };
    }
    
    console.log('\n👂 开始监听 XMTP 消息...');
    
    const result = await this.client.startListening(async (message, content) => {
      console.log(`\n📨 收到 XMTP 消息:`);
      console.log(`   来自：${message.senderAddress}`);
      console.log(`   类型：${content?.type || 'unknown'}`);
      
      // 保存到持久化存储
      const stored = this.messageStore.saveReceived({
        id: message.id,
        senderAddress: message.senderAddress,
        sent: message.sent,
        content: content
      });
      
      if (stored) {
        // 通知所有处理器
        for (const handler of this.messageHandlers) {
          try {
            await handler(stored, content);
          } catch (e) {
            console.error(`   ❌ 处理器异常：${e.message}`);
          }
        }
        
        // 标记为已处理
        this.messageStore.markProcessed(stored.id);
      }
    });
    
    if (result.success) {
      this.isListening = true;
      console.log('   ✅ 监听已开始');
    }
    
    return result;
  }
  
  /**
   * 发送消息
   */
  async sendMessage(toAddress, content) {
    if (!this.isConnected) {
      return { success: false, error: 'XMTP 未连接' };
    }
    
    console.log(`\n📨 发送消息给 ${toAddress.substring(0, 10)}...`);
    
    const result = await this.client.sendMessage(toAddress, content);
    
    if (result.success) {
      // 保存发送记录
      this.messageStore.saveMessage({
        id: `sent_${Date.now()}`,
        senderAddress: this.address,
        recipientAddress: toAddress,
        sent: Date.now(),
        content: content,
        status: 'sent',
        direction: 'outbound'
      });
      console.log('   ✅ 消息已发送并保存');
    } else {
      console.log(`   ❌ 发送失败：${result.error}`);
    }
    
    return result;
  }
  
  /**
   * 注册消息处理器
   */
  onMessage(handler) {
    this.messageHandlers.push(handler);
    console.log(`   📝 注册消息处理器 (共 ${this.messageHandlers.length} 个)`);
  }
  
  /**
   * 获取消息统计
   */
  getStats() {
    return {
      connected: this.isConnected,
      listening: this.isListening,
      address: this.address,
      ...this.messageStore.getStats()
    };
  }
  
  /**
   * 获取对话历史
   */
  getConversation(peerAddress) {
    return this.messageStore.getConversation(peerAddress);
  }
  
  /**
   * 获取所有消息
   */
  getAllMessages(options = {}) {
    return this.messageStore.loadMessages();
  }
  
  /**
   * 断开连接
   */
  async disconnect() {
    this.isListening = false;
    this.isConnected = false;
    await this.client.disconnect();
    console.log('🔌 XMTP 已断开连接');
  }
  
  /**
   * 清理旧消息
   */
  cleanup(keepLast = 1000) {
    return this.messageStore.cleanup(keepLast);
  }
}

export default XMTPIntegration;
