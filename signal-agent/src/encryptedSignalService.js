import { ethers } from 'ethers';
import { eciesEncrypt, eciesDecrypt } from './ecies.js';
import fs from 'fs';
import path from 'path';

/**
 * 加密信号轮询服务
 * 
 * Provider 侧：
 * - 轮询 Escrow 合约，获取待交付的购买
 * - 用 Buyer 公钥加密信号内容
 * - 提交加密内容到合约
 * 
 * Buyer 侧：
 * - 轮询 Escrow 合约，获取已交付的加密信号
 * - 下载加密内容到本地
 * - 本地解密并保存
 */

export class EncryptedSignalService {
  constructor(
    escrowContract,
    publicKeyRegistryContract,
    wallet
  ) {
    this.escrow = escrowContract;
    this.publicKeyRegistry = publicKeyRegistryContract;
    this.wallet = wallet;
    this.address = wallet.address;
    
    // 本地存储目录
    this.encryptedSignalsDir = path.join(
      process.cwd(),
      `encrypted_signals_${this.address.slice(0, 10)}`
    );
    
    if (!fs.existsSync(this.encryptedSignalsDir)) {
      fs.mkdirSync(this.encryptedSignalsDir, { recursive: true });
    }
  }
  
  /**
   * 注册公钥（一次性操作）
   */
  async registerPublicKey() {
    try {
      const publicKey = this.getPublicKey();
      const tx = await this.publicKeyRegistry.registerPublicKey(publicKey);
      await tx.wait();
      console.log(`✅ 公钥已注册：${publicKey.substring(0, 16)}...`);
      return publicKey;
    } catch (e) {
      console.error('❌ 公钥注册失败:', e.message);
      throw e;
    }
  }
  
  /**
   * 获取当前钱包的公钥
   */
  getPublicKey() {
    const privateKey = this.wallet.signingKey.privateKey;
    const publicKey = privateKey.slice(2); // 移除 0x
    // 确保是 64 字节
    return publicKey.padStart(128, '0');
  }
  
  /**
   * Provider: 轮询待交付的购买
   */
  async pollPendingDeliveries() {
    try {
      const pendingIds = await this.escrow.getPendingDeliveries(this.address);
      
      if (pendingIds.length === 0) {
        return [];
      }
      
      console.log(`📬 发现 ${pendingIds.length} 个待交付的购买`);
      
      const pending = [];
      for (const purchaseId of pendingIds) {
        const purchase = await this.getPurchaseDetails(purchaseId);
        pending.push(purchase);
      }
      
      return pending;
    } catch (e) {
      console.error('❌ 轮询待交付失败:', e.message);
      return [];
    }
  }
  
  /**
   * Provider: 交付加密信号
   * @param purchaseId 购买 ID
   * @param signalContent 信号内容（JSON 字符串）
   */
  async deliverEncryptedSignal(purchaseId, signalContent) {
    try {
      const purchase = await this.getPurchaseDetails(purchaseId);
      
      if (purchase.delivered) {
        console.log(`⚠️  Purchase #${purchaseId} 已交付`);
        return { success: false, message: 'Already delivered' };
      }
      
      console.log(`\n🔐 加密信号内容...`);
      console.log(`   Purchase ID: ${purchaseId}`);
      console.log(`   Buyer: ${purchase.buyer}`);
      console.log(`   Buyer Public Key: ${purchase.buyerPublicKey.substring(0, 16)}...`);
      
      // ECIES 加密
      const encryptedContent = await eciesEncrypt(
        purchase.buyerPublicKey,
        signalContent
      );
      
      console.log(`   加密后长度：${encryptedContent.length} bytes`);
      
      // 提交到合约
      console.log(`\n📤 提交加密内容到合约...`);
      const tx = await this.escrow.deliver(purchaseId, encryptedContent);
      await tx.wait();
      
      console.log(`✅ 交付成功！交易哈希：${tx.hash}`);
      
      // 本地记录
      this.saveDeliveryRecord(purchaseId, encryptedContent);
      
      return {
        success: true,
        txHash: tx.hash,
        purchaseId,
        encryptedContent
      };
    } catch (e) {
      console.error('❌ 交付失败:', e.message);
      return { success: false, message: e.message };
    }
  }
  
  /**
   * Buyer: 轮询已交付的加密信号
   */
  async pollEncryptedSignals() {
    try {
      const encryptedIds = await this.escrow.getEncryptedSignals(this.address);
      
      if (encryptedIds.length === 0) {
        return [];
      }
      
      console.log(`📬 发现 ${encryptedIds.length} 个待下载的加密信号`);
      
      const signals = [];
      for (const purchaseId of encryptedIds) {
        const signal = await this.downloadEncryptedSignal(purchaseId);
        signals.push(signal);
      }
      
      return signals;
    } catch (e) {
      console.error('❌ 轮询加密信号失败:', e.message);
      return [];
    }
  }
  
  /**
   * Buyer: 下载加密信号
   * @param purchaseId 购买 ID
   */
  async downloadEncryptedSignal(purchaseId) {
    try {
      const [encryptedContent, deliverTimestamp] = await this.escrow.getEncryptedContent(purchaseId);
      const purchase = await this.getPurchaseDetails(purchaseId);
      
      const signalData = {
        purchaseId: purchaseId.toString(),
        signalId: purchase.signalId.toString(),
        provider: purchase.provider,
        encryptedContent,
        deliverTimestamp: deliverTimestamp.toString(),
        downloadedAt: Date.now()
      };
      
      // 保存到本地
      this.saveEncryptedSignal(purchaseId, signalData);
      
      console.log(`✅ 已下载 Purchase #${purchaseId}`);
      
      return signalData;
    } catch (e) {
      console.error('❌ 下载失败:', e.message);
      return null;
    }
  }
  
  /**
   * Buyer: 解密本地信号
   * @param purchaseId 购买 ID
   */
  async decryptLocalSignal(purchaseId) {
    try {
      const signalData = this.loadEncryptedSignal(purchaseId);
      
      if (!signalData) {
        return { success: false, message: 'Signal not found locally' };
      }
      
      if (signalData.decryptedContent) {
        return {
          success: true,
          content: signalData.decryptedContent,
          alreadyDecrypted: true
        };
      }
      
      console.log(`\n🔓 解密信号 #${purchaseId}...`);
      
      const privateKey = this.wallet.signingKey.privateKey.slice(2);
      const decryptedContent = await eciesDecrypt(
        privateKey,
        signalData.encryptedContent
      );
      
      // 更新本地存储
      signalData.decryptedContent = decryptedContent;
      signalData.decryptedAt = Date.now();
      this.saveEncryptedSignal(purchaseId, signalData);
      
      console.log(`✅ 解密成功！`);
      
      return {
        success: true,
        content: decryptedContent,
        alreadyDecrypted: false
      };
    } catch (e) {
      console.error('❌ 解密失败:', e.message);
      return { success: false, message: e.message };
    }
  }
  
  /**
   * Buyer: 确认交付（释放资金给 Provider）
   * @param purchaseId 购买 ID
   */
  async confirmDelivery(purchaseId) {
    try {
      console.log(`\n✅ 确认交付 Purchase #${purchaseId}...`);
      
      const tx = await this.escrow.confirmDelivery(purchaseId);
      await tx.wait();
      
      console.log(`✅ 确认成功！交易哈希：${tx.hash}`);
      
      return {
        success: true,
        txHash: tx.hash
      };
    } catch (e) {
      console.error('❌ 确认失败:', e.message);
      return { success: false, message: e.message };
    }
  }
  
  /**
   * Buyer: 超时退款
   * @param purchaseId 购买 ID
   * @param timeoutSeconds 超时时间（秒）
   */
  async refund(purchaseId, timeoutSeconds = 86400) {
    try {
      console.log(`\n💰 申请退款 Purchase #${purchaseId}...`);
      
      const tx = await this.escrow.refund(purchaseId, timeoutSeconds);
      await tx.wait();
      
      console.log(`✅ 退款成功！交易哈希：${tx.hash}`);
      
      return {
        success: true,
        txHash: tx.hash
      };
    } catch (e) {
      console.error('❌ 退款失败:', e.message);
      return { success: false, message: e.message };
    }
  }
  
  // ========== 辅助方法 ==========
  
  async getPurchaseDetails(purchaseId) {
    const result = await this.escrow.getPurchase(purchaseId);
    return {
      purchaseId: result[0].toString(),
      signalId: result[1].toString(),
      buyer: result[2],
      provider: result[3],
      amount: result[4].toString(),
      buyerPublicKey: result[5],
      timestamp: result[6].toString(),
      delivered: result[7],
      confirmed: result[8],
      refunded: result[9]
    };
  }
  
  saveEncryptedSignal(purchaseId, signalData) {
    const filename = `purchase_${purchaseId}.json`;
    const filepath = path.join(this.encryptedSignalsDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(signalData, null, 2));
  }
  
  loadEncryptedSignal(purchaseId) {
    const filename = `purchase_${purchaseId}.json`;
    const filepath = path.join(this.encryptedSignalsDir, filename);
    
    if (!fs.existsSync(filepath)) {
      return null;
    }
    
    const content = fs.readFileSync(filepath, 'utf-8');
    return JSON.parse(content);
  }
  
  saveDeliveryRecord(purchaseId, encryptedContent) {
    const filename = `delivery_${purchaseId}.json`;
    const filepath = path.join(this.encryptedSignalsDir, filename);
    
    const record = {
      purchaseId: purchaseId.toString(),
      encryptedContent,
      deliveredAt: Date.now()
    };
    
    fs.writeFileSync(filepath, JSON.stringify(record, null, 2));
  }
}

export default EncryptedSignalService;
