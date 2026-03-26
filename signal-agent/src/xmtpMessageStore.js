/**
 * XMTP 消息持久化存储模块
 * 
 * 功能：
 * 1. 保存所有收到的 XMTP 消息到本地数据库
 * 2. 支持离线消息检索
 * 3. 消息状态追踪（已读/未读/已处理）
 */

import fs from 'fs';
import path from 'path';

export class MessageStore {
  constructor(walletAddress) {
    this.walletAddress = walletAddress;
    const safeAddress = walletAddress.replace('0x', '').substring(0, 10).toLowerCase();
    this.storeDir = path.join(process.cwd(), `xmtp_store_${safeAddress}`);
    this.messagesFile = path.join(this.storeDir, 'messages.json');
    this.indexFile = path.join(this.storeDir, 'index.json');
    
    // 确保存储目录存在
    if (!fs.existsSync(this.storeDir)) {
      fs.mkdirSync(this.storeDir, { recursive: true });
      console.log(`📁 XMTP 消息存储目录：${this.storeDir}`);
    }
    
    // 初始化索引
    this.index = this.loadIndex();
  }
  
  /**
   * 加载索引
   */
  loadIndex() {
    if (fs.existsSync(this.indexFile)) {
      const data = JSON.parse(fs.readFileSync(this.indexFile, 'utf-8'));
      return {
        processedIds: new Set(data.processedIds || []),
        messageCount: data.messageCount || 0
      };
    }
    return { processedIds: new Set(), messageCount: 0 };
  }
  
  /**
   * 保存索引
   */
  saveIndex() {
    const data = {
      processedIds: [...this.index.processedIds],
      messageCount: this.index.messageCount
    };
    fs.writeFileSync(this.indexFile, JSON.stringify(data, null, 2));
  }
  
  /**
   * 加载所有消息
   */
  loadMessages() {
    if (fs.existsSync(this.messagesFile)) {
      return JSON.parse(fs.readFileSync(this.messagesFile, 'utf-8'));
    }
    return [];
  }
  
  /**
   * 保存消息
   */
  saveMessage(message) {
    const messages = this.loadMessages();
    messages.push(message);
    fs.writeFileSync(this.messagesFile, JSON.stringify(messages, null, 2));
    this.index.messageCount++;
    this.saveIndex();
    return message;
  }
  
  /**
   * 保存收到的消息（带去重）
   */
  saveReceived(message) {
    const messageId = message.id || `${message.senderAddress}_${message.sent}`;
    
    // 检查是否已处理
    if (this.index.processedIds.has(messageId)) {
      console.log(`   ⚠️  消息已处理：${messageId}`);
      return null;
    }
    
    const storedMessage = {
      id: messageId,
      senderAddress: message.senderAddress,
      sent: message.sent,
      content: message.content,
      receivedAt: Date.now(),
      status: 'received', // received, processing, processed, failed
      read: false
    };
    
    this.saveMessage(storedMessage);
    console.log(`   ✅ 消息已保存：${messageId}`);
    return storedMessage;
  }
  
  /**
   * 标记消息为已处理
   */
  markProcessed(messageId) {
    const messages = this.loadMessages();
    const message = messages.find(m => m.id === messageId);
    if (message) {
      message.status = 'processed';
      message.processedAt = Date.now();
      fs.writeFileSync(this.messagesFile, JSON.stringify(messages, null, 2));
      this.index.processedIds.add(messageId);
      this.saveIndex();
      return true;
    }
    return false;
  }
  
  /**
   * 获取未读消息
   */
  getUnreadMessages() {
    const messages = this.loadMessages();
    return messages.filter(m => !m.read && m.status === 'received');
  }
  
  /**
   * 获取待处理消息
   */
  getPendingMessages() {
    const messages = this.loadMessages();
    return messages.filter(m => m.status === 'received' || m.status === 'processing');
  }
  
  /**
   * 获取与特定地址的消息历史
   */
  getConversation(peerAddress) {
    const messages = this.loadMessages();
    return messages.filter(m => 
      m.senderAddress?.toLowerCase() === peerAddress.toLowerCase()
    );
  }
  
  /**
   * 获取统计信息
   */
  getStats() {
    const messages = this.loadMessages();
    return {
      total: messages.length,
      received: messages.filter(m => m.status === 'received').length,
      processing: messages.filter(m => m.status === 'processing').length,
      processed: messages.filter(m => m.status === 'processed').length,
      failed: messages.filter(m => m.status === 'failed').length
    };
  }
  
  /**
   * 清理旧消息（保留最近 N 条）
   */
  cleanup(keepLast = 1000) {
    const messages = this.loadMessages();
    if (messages.length > keepLast) {
      const removed = messages.splice(0, messages.length - keepLast);
      fs.writeFileSync(this.messagesFile, JSON.stringify(messages, null, 2));
      console.log(`🧹 清理了 ${removed.length} 条旧消息`);
      return removed.length;
    }
    return 0;
  }
  
  /**
   * 导出消息（用于备份）
   */
  exportMessages(startTime, endTime) {
    const messages = this.loadMessages();
    return messages.filter(m => {
      const timestamp = m.sent || m.receivedAt;
      return timestamp >= startTime && timestamp <= endTime;
    });
  }
}

export default MessageStore;
