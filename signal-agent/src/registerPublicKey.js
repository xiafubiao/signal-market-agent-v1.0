import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

async function registerPublicKey() {
  console.log('🔑 注册公钥到 PublicKeyRegistry...\n');
  
  const provider = new ethers.JsonRpcProvider(
    process.env.XLAYER_RPC_URL || 'https://testrpc.xlayer.tech/terigon'
  );
  
  const wallet = new ethers.Wallet(process.env.PROVIDER_PRIVATE_KEY, provider);
  console.log(`钱包地址：${wallet.address}`);
  
  // 连接 PublicKeyRegistry 合约
  const publicKeyRegistryAddress = process.env.PUBLIC_KEY_REGISTRY;
  if (!publicKeyRegistryAddress) {
    console.log('❌ 错误：未配置 PUBLIC_KEY_REGISTRY 地址');
    console.log('请先运行部署脚本：node deploy-escrow.js');
    return;
  }
  
  const PublicKeyRegistryABI = [
    'function registerPublicKey(string calldata publicKey) external',
    'function getPublicKey(address user) external view returns (string memory)',
    'function isRegistered(address user) external view returns (bool)'
  ];
  
  const publicKeyRegistry = new ethers.Contract(
    publicKeyRegistryAddress,
    PublicKeyRegistryABI,
    wallet
  );
  
  // 检查是否已注册
  const isRegistered = await publicKeyRegistry.isRegistered(wallet.address);
  if (isRegistered) {
    const existingKey = await publicKeyRegistry.getPublicKey(wallet.address);
    console.log(`✅ 公钥已注册：${existingKey.substring(0, 16)}...`);
    console.log('如需更新，直接重新注册即可');
  }
  
  // 生成公钥
  const publicKey = wallet.signingKey.publicKey.slice(4); // 移除 0x04 前缀
  console.log(`\n📝 公钥：${publicKey}`);
  console.log(`   长度：${publicKey.length} 字符`);
  
  // 注册
  console.log('\n⏳ 提交注册交易...');
  const tx = await publicKeyRegistry.registerPublicKey(publicKey);
  console.log(`交易哈希：${tx.hash}`);
  
  await tx.wait();
  console.log('\n✅ 公钥注册成功！');
  
  // 验证
  const registeredKey = await publicKeyRegistry.getPublicKey(wallet.address);
  console.log(`已注册的公钥：${registeredKey}`);
  console.log(`匹配：${registeredKey === publicKey ? '✓' : '✗'}`);
}

registerPublicKey().catch(console.error);
