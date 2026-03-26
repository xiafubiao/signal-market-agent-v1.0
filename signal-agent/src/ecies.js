import * as ecc from '@noble/secp256k1';
import { keccak256 } from 'ethers';
import { randomBytes } from 'crypto';

/**
 * ECIES 加密解密工具 (基于 ecies-geth 实现)
 * 
 * 加密格式：
 * - 首字节：0x04 (uncompressed marker)
 * - ephemeralPublicKey: 65 bytes (uncompressed)
 * - iv: 16 bytes
 * - ciphertext: variable
 * - mac: 32 bytes
 */

// 从私钥生成公钥 (uncompressed, 65 bytes)
export function getPublicKeyFromPrivateKey(privateKey) {
  const privateKeyBytes = privateKey.startsWith('0x') 
    ? Buffer.from(privateKey.slice(2), 'hex')
    : Buffer.from(privateKey, 'hex');
  
  const publicKey = ecc.getPublicKey(privateKeyBytes, false); // false = uncompressed (65 bytes)
  return Buffer.from(publicKey).toString('hex').substring(2); // 移除 04 前缀，返回 128 字符 hex
}

// ECIES 加密
export async function eciesEncrypt(publicKeyHex, message) {
  const messageBuffer = Buffer.from(message, 'utf-8');
  
  // 处理公钥格式：确保是 uncompressed (65 bytes)
  let publicKeyBytes;
  if (publicKeyHex.startsWith('0x')) {
    publicKeyHex = publicKeyHex.slice(2);
  }
  if (publicKeyHex.length === 128) {
    // 添加 04 前缀
    publicKeyBytes = Buffer.from('04' + publicKeyHex, 'hex');
  } else if (publicKeyHex.length === 130 && publicKeyHex.startsWith('04')) {
    publicKeyBytes = Buffer.from(publicKeyHex, 'hex');
  } else {
    throw new Error('Invalid public key length: ' + publicKeyHex.length);
  }
  
  // 生成临时密钥对
  const ephemeralPrivateKey = randomBytes(32);
  const ephemeralPublicKey = ecc.getPublicKey(ephemeralPrivateKey, false); // uncompressed (65 bytes)
  
  // ECDH 密钥派生 (使用 uncompressed 公钥)
  const sharedSecret = ecc.getSharedSecret(ephemeralPrivateKey, publicKeyBytes, false);
  
  // 派生加密密钥和 MAC 密钥 (使用 keccak256)
  const derivedKey = deriveKey(Buffer.from(sharedSecret));
  const encryptionKey = derivedKey.slice(0, 16);
  const macKey = derivedKey.slice(16, 32);
  
  // AES-CTR 加密
  const iv = randomBytes(16);
  const cipher = await aesCtrEncrypt(messageBuffer, encryptionKey, iv);
  
  // 计算 MAC (使用 hmac-sha256)
  const macData = Buffer.concat([Buffer.from(ephemeralPublicKey), iv, cipher]);
  const mac = await computeMAC(macData, macKey);
  
  // 组装：0x04 + ephemeralPublicKey(65) + iv(16) + ciphertext + mac(32)
  const result = Buffer.concat([
    Buffer.from([0x04]),  // 添加首字节 0x04
    Buffer.from(ephemeralPublicKey),
    iv,
    cipher,
    Buffer.from(mac)
  ]);
  
  return result;
}

// ECIES 解密
export async function eciesDecrypt(privateKeyHex, encrypted) {
  // 处理输入格式
  let encryptedBuffer;
  if (typeof encrypted === 'string') {
    // 检查是 hex 还是 base64
    if (encrypted.startsWith('0x')) {
      // hex 格式（从合约读取）
      encryptedBuffer = Buffer.from(encrypted.slice(2), 'hex');
    } else if (/^[0-9a-fA-F]+$/.test(encrypted)) {
      // hex 格式（不带 0x）
      encryptedBuffer = Buffer.from(encrypted, 'hex');
    } else {
      // base64 格式
      encryptedBuffer = Buffer.from(encrypted, 'base64');
    }
  } else {
    encryptedBuffer = encrypted;
  }
  
  // 验证首字节
  if (encryptedBuffer[0] !== 0x04) {
    throw new Error(`Not a valid ciphertext. It should begin with 4 but actually begin with ${encryptedBuffer[0]}`);
  }
  
  // 解析加密数据
  const ephemeralPublicKey = encryptedBuffer.slice(1, 66);   // 65 bytes (uncompressed)
  const iv = encryptedBuffer.slice(66, 82);                  // 16 bytes
  const mac = encryptedBuffer.slice(-32);                    // 32 bytes
  const ciphertext = encryptedBuffer.slice(82, -32);
  
  // 处理私钥格式 - 确保是 32 字节 Uint8Array
  let privateKeyBytes;
  if (typeof privateKeyHex === 'string') {
    if (privateKeyHex.startsWith('0x')) {
      privateKeyHex = privateKeyHex.slice(2);
    }
    // 确保是 64 字符（32 字节）
    if (privateKeyHex.length !== 64) {
      throw new Error(`Invalid private key length: ${privateKeyHex.length}, expected 64`);
    }
    privateKeyBytes = Uint8Array.from(Buffer.from(privateKeyHex, 'hex'));
  } else {
    privateKeyBytes = Uint8Array.from(privateKeyHex);
  }
  
  // ECDH 密钥派生
  const sharedSecret = ecc.getSharedSecret(privateKeyBytes, ephemeralPublicKey, false);
  const derivedKey = deriveKey(Buffer.from(sharedSecret));
  const encryptionKey = derivedKey.slice(0, 16);
  const macKey = derivedKey.slice(16, 32);
  
  // 验证 MAC
  const macData = Buffer.concat([ephemeralPublicKey, iv, ciphertext]);
  const expectedMac = await computeMAC(macData, macKey);
  
  if (!buffersEqual(mac, Buffer.from(expectedMac))) {
    throw new Error('MAC verification failed');
  }
  
  // AES-CTR 解密
  const plaintext = await aesCtrDecrypt(ciphertext, encryptionKey, iv);
  
  return plaintext.toString('utf-8');
}

// 密钥派生函数 (keccak256)
function deriveKey(sharedSecret) {
  // sharedSecret 是 Uint8Array (65 bytes, uncompressed)
  // 转换为 hex 字符串，跳过首字节 0x04
  const sharedSecretHex = Buffer.from(sharedSecret).toString('hex').substring(2);
  const hash = keccak256('0x' + sharedSecretHex);
  return Buffer.from(hash.slice(2), 'hex');
}

// AES-CTR 加密
async function aesCtrEncrypt(plaintext, key, iv) {
  const crypto = await import('crypto');
  const cipher = crypto.createCipheriv('aes-128-ctr', key, iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

// AES-CTR 解密
async function aesCtrDecrypt(ciphertext, key, iv) {
  const crypto = await import('crypto');
  const decipher = crypto.createDecipheriv('aes-128-ctr', key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// 计算 HMAC-SHA256
async function computeMAC(data, key) {
  const crypto = await import('crypto');
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(data);
  return hmac.digest();
}

// Buffer 比较
function buffersEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export default { eciesEncrypt, eciesDecrypt, getPublicKeyFromPrivateKey };
