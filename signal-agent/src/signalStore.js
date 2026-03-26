import fs from 'fs';
import path from 'path';

/**
 * Agent Session 本地存储
 * 
 * 目录结构：
 * agent-sessions/
 *   agent-0xA70288A056/
 *     signals/
 *       signal_1.json
 *     proofs/
 *       proof_BTC-USDT_xxx.json
 */

export class SignalStore {
  constructor(providerAddress) {
    this.providerAddress = providerAddress;
    
    // 使用 agent-session 目录
    const safeAddress = providerAddress.replace('0x', '').substring(0, 10);
    this.sessionDir = path.join(process.cwd(), 'agent-sessions', `agent-${safeAddress}`);
    this.signalsDir = path.join(this.sessionDir, 'signals');
    this.proofsDir = path.join(this.sessionDir, 'proofs');
    
    // 确保目录存在
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
      console.log(`📁 Agent Session 目录已创建：${this.sessionDir}`);
    }
    if (!fs.existsSync(this.signalsDir)) {
      fs.mkdirSync(this.signalsDir, { recursive: true });
      console.log(`📁 Signals 目录已创建：${this.signalsDir}`);
    }
    if (!fs.existsSync(this.proofsDir)) {
      fs.mkdirSync(this.proofsDir, { recursive: true });
      console.log(`📁 Proofs 目录已创建：${this.proofsDir}`);
    }
  }
  
  /**
   * 保存完整信号到本地
   * @param {string|number} signalId - 信号 ID
   * @param {string} contentString - 完整内容字符串（JSON 或其他格式）
   * @param {string} proofTxHash - zkTLS 证明上链的交易哈希
   */
  saveFullSignal(signalId, contentString, proofTxHash = '') {
    const filename = `signal_${signalId}.json`;
    const filepath = path.join(this.signalsDir, filename);
    
    const signalData = {
      signalId: signalId.toString(),
      provider: this.providerAddress,
      content: contentString,  // ✅ 完整内容字符串
      proofTxHash: proofTxHash,  // ✅ zkTLS 证明上链的交易哈希
      createdAt: Date.now(),
      purchasedBy: []
    };
    
    fs.writeFileSync(filepath, JSON.stringify(signalData, null, 2));
    console.log(`   📝 完整信号已保存到：${filepath}`);
    
    return filepath;
  }
  
  /**
   * 获取完整信号数据
   * @returns {{signalId: string, content: string, proofTxHash: string, purchasedBy: string[]}|null} 完整信号数据
   */
  getFullSignal(signalId) {
    const filename = `signal_${signalId}.json`;
    const filepath = path.join(this.signalsDir, filename);
    
    if (!fs.existsSync(filepath)) {
      return null;
    }
    
    const signalData = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    return signalData;  // 返回完整对象
  }
  
  /**
   * 保存 Proof 到本地
   * @param {string} filename - 文件名（如：pnl_BTC-USDT_123456.json）
   * @param {object} proofData - Proof 数据
   */
  saveProof(filename, proofData) {
    const filepath = path.join(this.proofsDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(proofData, null, 2));
    console.log(`   📝 Proof 已保存到：${filepath}`);
    return filepath;
  }
  
  /**
   * 获取 Proof 数据
   * @param {string} filename - 文件名
   */
  getProof(filename) {
    const filepath = path.join(this.proofsDir, filename);
    if (!fs.existsSync(filepath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  }
  
  /**
   * 记录购买（Provider 记录谁买了）
   */
  recordPurchase(signalId, buyer) {
    const signal = this.getFullSignal(signalId);
    if (!signal) return false;
    
    if (!signal.purchasedBy) signal.purchasedBy = [];
    if (!signal.purchasedBy.includes(buyer.toLowerCase())) {
      signal.purchasedBy.push(buyer.toLowerCase());
      const filepath = path.join(this.signalsDir, `signal_${signalId}.json`);
      fs.writeFileSync(filepath, JSON.stringify(signal, null, 2));
      console.log(`   ✅ 已记录购买者：${buyer}`);
    }
    
    return true;
  }
  
  /**
   * 检查用户是否已购买
   */
  hasPurchased(signalId, buyer) {
    const signal = this.getFullSignal(signalId);
    if (!signal) return false;
    return signal.purchasedBy.includes(buyer.toLowerCase());
  }
}

export default SignalStore;
