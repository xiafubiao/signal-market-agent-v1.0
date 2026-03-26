/**
 * XMTP 客户端实现 (使用 @xmtp/xmtp-js)
 */

import { Client } from '@xmtp/xmtp-js';
import { ethers } from 'ethers';

export class XMTPClient {
  constructor(wallet, options = {}) {
    this.wallet = wallet;
    this.address = wallet.address;
    this.client = null;
    this.isListening = false;
    this.env = options.env || 'production';
    
    console.log(`🔑 XMTP 客户端已创建`);
    console.log(`   钱包地址：${this.address}`);
    console.log(`   网络：${this.env}`);
  }
  
  async connect() {
    try {
      console.log('\n📡 连接 XMTP 网络...');
      
      this.client = await Client.create(this.wallet, { 
        env: this.env 
      });
      
      console.log(`   ✅ XMTP 连接成功`);
      console.log(`   XMTP 地址：${this.client.address}`);
      
      return { success: true, client: this.client };
      
    } catch (e) {
      console.error('   ❌ XMTP 连接失败:', e.message);
      return { success: false, error: e.message };
    }
  }
  
  async sendMessage(toAddress, message) {
    if (!this.client) {
      return { success: false, error: 'XMTP 未连接' };
    }
    
    try {
      console.log(`\n📨 发送 XMTP 消息...`);
      console.log(`   发送方：${this.address}`);
      console.log(`   接收方：${toAddress}`);
      
      const conversation = await this.client.conversations.newConversation(toAddress);
      await conversation.send(message);
      
      console.log(`   ✅ 消息已发送`);
      
      return { success: true, conversationId: conversation.context?.conversationId };
      
    } catch (e) {
      console.error('   ❌ 发送失败:', e.message);
      return { success: false, error: e.message };
    }
  }
  
  async startListening(callback) {
    if (!this.client) {
      return { success: false, error: 'XMTP 未连接' };
    }
    
    if (this.isListening) {
      return { success: false, error: '已在监听中' };
    }
    
    console.log('\n👂 开始监听 XMTP 消息...');
    this.isListening = true;
    
    try {
      const conversations = await this.client.conversations.list();
      console.log(`   找到 ${conversations.length} 个对话`);
      
      for (const conversation of conversations) {
        this.listenToConversation(conversation, callback);
      }
      
      const stream = await this.client.conversations.stream();
      console.log('   ✅ 开始监听新对话...');
      
      for await (const conversation of stream) {
        console.log(`   💬 新对话：${conversation.peerAddress}`);
        this.listenToConversation(conversation, callback);
      }
      
      return { success: true };
      
    } catch (e) {
      console.error('   ❌ 监听失败:', e.message);
      return { success: false, error: e.message };
    }
  }
  
  async listenToConversation(conversation, callback) {
    console.log(`   👂 监听对话：${conversation.peerAddress}`);
    
    const stream = await conversation.streamMessages();
    
    for await (const message of stream) {
      console.log(`   📨 收到消息`);
      
      try {
        const content = typeof message.content === 'string' 
          ? JSON.parse(message.content) 
          : message.content;
        if (callback) {
          await callback(message, content);
        }
      } catch (e) {
        console.log('   ⚠️  消息解析失败:', e.message);
      }
    }
  }
  
  async disconnect() {
    this.isListening = false;
    console.log('🔌 XMTP 客户端已断开');
  }
}

export default XMTPClient;
