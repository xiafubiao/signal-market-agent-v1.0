import 'dotenv/config';
import { PrimusCoreTLS } from '@primuslabs/zktls-core-sdk';
import { ethers } from 'ethers';
import CryptoJS from 'crypto-js';
import fs from 'fs';
import path from 'path';

/**
 * OKX API 签名生成
 */
function buildOKXHeaders({ method, requestPath, body = '' }) {
  const apiKey = process.env.OKX_API_KEY;
  const secretKey = process.env.OKX_SECRET_KEY;
  const passphrase = process.env.OKX_PASSPHRASE;

  if (!apiKey || !secretKey || !passphrase) {
    throw new Error('Missing OKX credentials in .env');
  }

  const timestamp = new Date().toISOString();
  const preHash = timestamp + method.toUpperCase() + requestPath + body;
  const sign = CryptoJS.enc.Base64.stringify(
    CryptoJS.HmacSHA256(preHash, secretKey)
  );

  return {
    'OK-ACCESS-KEY': apiKey,
    'OK-ACCESS-SIGN': sign,
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': passphrase,
    'Content-Type': 'application/json'
  };
}

const OKX_BASE = 'https://www.okx.com';

/**
 * Primus zkTLS - 完整的证明生成
 * 
 * 功能对齐 provider-zktls:
 * 1. 同时证明 3 个 OKX 端点
 * 2. 获取 recentPnl, totalEq, kycLv, acctLv
 * 3. 保存完整 proof 到 proofs/ 目录
 */
export class PrimusZkTLS {
  constructor(appId, appSecret) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.proofsDir = path.join(process.cwd(), 'proofs');
    
    // 确保证明目录存在
    if (!fs.existsSync(this.proofsDir)) {
      fs.mkdirSync(this.proofsDir, { recursive: true });
    }
  }
  
  /**
   * 生成完整的 zkTLS 证明（3 个端点）
   * 
   * @param {string} instId - 币种对，如 "BTC-USDT"
   * @returns {Promise<{success: boolean, proof?: object, error?: string}>}
   */
  async proveAll(instId = 'BTC-USDT') {
    try {
      console.log('\n[Primus] Initializing zktls-core-sdk...');
      const zkTLS = new PrimusCoreTLS();
      const initResult = await zkTLS.init(this.appId, this.appSecret);
      console.log('[Primus] Init result:', initResult);
      
      // 构建 3 个 OKX 请求
      const billsPath = `/api/v5/account/bills?instId=${instId}&type=2&limit=1`;
      const balancePath = '/api/v5/account/balance';
      const configPath = '/api/v5/account/config';
      
      const request = [
        {
          url: OKX_BASE + billsPath,
          method: 'GET',
          header: buildOKXHeaders({ method: 'GET', requestPath: billsPath }),
          body: ''
        },
        {
          url: OKX_BASE + balancePath,
          method: 'GET',
          header: buildOKXHeaders({ method: 'GET', requestPath: balancePath }),
          body: ''
        },
        {
          url: OKX_BASE + configPath,
          method: 'GET',
          header: buildOKXHeaders({ method: 'GET', requestPath: configPath }),
          body: ''
        }
      ];
      
      // 二维 responseResolves 数组
      const responseResolves = [
        [{ keyName: 'recentPnl', parseType: 'json', parsePath: '$.data[0].pnl' }],
        [{ keyName: 'totalEq', parseType: 'json', parsePath: '$.data[0].totalEq' }],
        [
          { keyName: 'kycLv', parseType: 'json', parsePath: '$.data[0].kycLv' },
          { keyName: 'acctLv', parseType: 'json', parsePath: '$.data[0].acctLv' }
        ]
      ];
      
      console.log(`\n[Primus] InstId: ${instId}`);
      console.log(`[Primus] URL[0]: ${request[0].url} → recentPnl`);
      console.log(`[Primus] URL[1]: ${request[1].url} → totalEq`);
      console.log(`[Primus] URL[2]: ${request[2].url} → kycLv, acctLv`);
      
      // 生成请求参数
      const generateRequest = zkTLS.generateRequestParams(request, responseResolves);
      generateRequest.setAttMode({ algorithmType: 'proxytls' });
      
      // 执行证明
      console.log('\n[Primus] Starting attestation...');
      const attestation = await zkTLS.startAttestation(generateRequest);
      console.log('[Primus] Attestation complete ✓');
      console.log('[Primus] Attestor:', attestation.attestors?.[0]?.attestorAddr || 'N/A');
      console.log('[Primus] Recipient:', attestation.recipient);
      
      // 验证签名
      const verifyResult = zkTLS.verifyAttestation(attestation);
      console.log(`[Primus] Signature verified: ${verifyResult}`);
      
      if (!verifyResult) {
        throw new Error('Attestation signature verification failed');
      }
      
      // 解析证明数据
      let proofData = attestation.data;
      if (typeof proofData === 'string') {
        proofData = JSON.parse(proofData);
      }
      
      console.log('\n📊 Proof Results:');
      console.log(`  [${instId}] recentPnl: ${proofData?.recentPnl ?? '(no data)'}`);
      console.log(`  totalEq: ${proofData?.totalEq ?? '(no data)'}`);
      console.log(`  kycLv: ${proofData?.kycLv ?? '(no data)'}`);
      console.log(`  acctLv: ${proofData?.acctLv ?? '(no data)'}`);
      
      // 保存证明到文件
      const proof = {
        instId,
        proofData,
        attestation,
        verifyResult,
        timestamp: attestation.timestamp
      };
      
      this.saveProof(proof);
      
      return {
        success: true,
        proof,
        message: '✅ zkTLS 证明生成成功'
      };
      
    } catch (e) {
      console.error('\n❌ Error:', e.message);
      
      // 错误提示
      const code = String(e?.code || e?.errorData?.code || '');
      const hints = {
        '30006': `账号在 ${instId} 没有交易记录 — 换一个有交易记录的币种对`,
        '30004': 'OKX 返回空响应 — 检查 API Key 权限',
        '10003': '代理 IP 被拦截 — 把 proxytls 改为 mpctls',
        '10001': '网络不稳定 — 重试'
      };
      if (hints[code]) {
        console.error(`  💡 提示：${hints[code]}`);
      }
      
      return {
        success: false,
        error: e.message
      };
    }
  }
  
  /**
   * 保存证明到文件
   */
  saveProof(proof) {
    const filename = `pnl_${proof.instId}_${Date.now()}.json`;
    const filepath = path.join(this.proofsDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(proof, null, 2));
    console.log(`\n✓ Proof saved → ${filepath}`);
  }
  
  /**
   * 生成交易证明（用于发布信号）
   * 封装 proveAll 并返回简化结果
   * 
   * @param {string} instId - 币种对
   * @returns {Promise<{success: boolean, attestation?: object, pnl?: string, totalEq?: string, kycLv?: string, acctLv?: string, error?: string}>}
   */
  async generateTradingProof(instId = 'BTC-USDT') {
    const result = await this.proveAll(instId);
    
    if (!result.success) {
      return result;
    }
    
    return {
      success: true,
      attestation: result.proof.attestation,
      pnl: result.proof.proofData?.recentPnl || '0',
      totalEq: result.proof.proofData?.totalEq || '0',
      kycLv: result.proof.proofData?.kycLv || '1',
      acctLv: result.proof.proofData?.acctLv || '1',
      message: `✅ 交易证明生成成功`
    };
  }
}

export default PrimusZkTLS;
