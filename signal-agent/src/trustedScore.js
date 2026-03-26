/**
 * Agent Signal Trusted Score Calculator
 * 
 * 根据 zkTLS proof 计算信号可信度评 points
 */

export class TrustedScoreCalculator {
  /**
   * 计算 trusted score
   * 
   * 规则:
   * 1. balance (totalEq): <1000→1  points，1000-10000→2  points，>10000→3  points
   * 2. kyc level: <2→1  points，=2→2  points，>2→3  points
   * 3. pnl: <100→1  points，100-500→2  points，500-1000→3  points，>1000→4  points
   * 4. pnl 币种Consistent性：Consistent不minus points，不Consistentminus 1  points
   * 
   * @param {object} proofData - zkTLS proof 数据
   * @param {string} signalInstId - 信号的币种 (如 "BTC-USDT")
   * @returns {{score: number, breakdown: object, level: string}}
   */
  calculateScore(proofData, signalInstId) {
    const breakdown = {
      balance: 0,
      kyc: 0,
      pnl: 0,
      consistency: 0,
      total: 0
    };
    
    const messages = [];
    
    // 1. Balance score (totalEq)
    const totalEq = parseFloat(proofData?.totalEq || 0);
    if (totalEq < 1000) {
      breakdown.balance = 1;
      messages.push(`Balance $${totalEq} < $1000 → 1  points`);
    } else if (totalEq <= 10000) {
      breakdown.balance = 2;
      messages.push(`Balance $${totalEq} ($1k-$10k) → 2  points`);
    } else {
      breakdown.balance = 3;
      messages.push(`Balance $${totalEq} > $10k → 3  points`);
    }
    
    // 2. KYC level score
    const kycLv = parseInt(proofData?.kycLv || 0);
    if (kycLv < 2) {
      breakdown.kyc = 1;
      messages.push(`KYC Lv${kycLv} < 2 → 1  points`);
    } else if (kycLv === 2) {
      breakdown.kyc = 2;
      messages.push(`KYC Lv${kycLv} = 2 → 2  points`);
    } else {
      breakdown.kyc = 3;
      messages.push(`KYC Lv${kycLv} > 2 → 3  points`);
    }
    
    // 3. PNL score
    const pnl = parseFloat(proofData?.recentPnl || 0);
    const absPnl = Math.abs(pnl);
    if (absPnl < 100) {
      breakdown.pnl = 1;
      messages.push(`PNL $${pnl} < $100 → 1  points`);
    } else if (absPnl <= 500) {
      breakdown.pnl = 2;
      messages.push(`PNL $${pnl} ($100-$500) → 2  points`);
    } else if (absPnl <= 1000) {
      breakdown.pnl = 3;
      messages.push(`PNL $${pnl} ($500-$1k) → 3  points`);
    } else {
      breakdown.pnl = 4;
      messages.push(`PNL $${pnl} > $1k → 4  points`);
    }
    
    // 4. Consistency check (PNL instId vs signal instId)
    // 假设 proofData 中包含 pnlInstId 字段
    const pnlInstId = proofData?.pnlInstId || '';
    breakdown.consistency = 0;
    
    if (pnlInstId && signalInstId) {
      const pnlBase = pnlInstId.split('-')[0].toUpperCase();
      const signalBase = signalInstId.split('-')[0].toUpperCase();
      
      if (pnlBase !== signalBase) {
        breakdown.consistency = -1;
        messages.push(`PNL currency (${pnlInstId}) ≠ Signal currency (${signalInstId}) → -1  points`);
      } else {
        messages.push(`PNL currencyConsistent (${pnlInstId} = ${signalInstId}) → 不minus points`);
      }
    } else {
      messages.push(`PNL currency数据缺失 → 不minus points`);
    }
    
    // Calculate total
    breakdown.total = breakdown.balance + breakdown.kyc + breakdown.pnl + breakdown.consistency;
    
    // Determine level
    let level = '⚪ Unknown';
    if (breakdown.total >= 10) {
      level = 'Excellent';
    } else if (breakdown.total >= 7) {
      level = 'Good';
    } else if (breakdown.total >= 4) {
      level = 'Fair';
    } else {
      level = 'Poor';
    }
    
    return {
      score: breakdown.total,
      breakdown,
      level,
      messages
    };
  }
  
  /**
   * 格式化评 points显示
   */
  formatScore(score, breakdown) {
    const stars = ''.repeat(Math.min(score, 10));
    return `${score}  points ${stars} (${breakdown.balance}+${breakdown.kyc}+${breakdown.pnl}${breakdown.consistency < 0 ? breakdown.consistency : '+' + breakdown.consistency})`;
  }
}

export default TrustedScoreCalculator;
