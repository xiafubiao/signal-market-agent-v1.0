const hre = require('hardhat');

// Primus Verifier 合约地址
// X Layer Testnet (chainId 1952): 官方已确认地址
// 最新地址以 Primus 官方文档为准: https://docs.primuslabs.xyz/
const PRIMUS_VERIFIER_XLAYER_TESTNET = '0xCE7cefB3B5A7eB44B59F60327A53c9Ce53B0afdE';
const PRIMUS_VERIFIER_BASE_SEPOLIA   = '0xCE7cefB3B5A7eB44B59F60327A53c9Ce53B0afdE';

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log('Deploying contracts with account:', deployer.address);
  console.log('Account balance:', (await hre.ethers.provider.getBalance(deployer.address)).toString());

  // 获取网络信息
  const network = await hre.ethers.provider.getNetwork();
  console.log('Network:', network.name, 'ChainId:', network.chainId.toString());

  // 选择 Primus Verifier 地址
  let primusVerifierAddress;
  if (network.chainId === 1952n) {
    primusVerifierAddress = PRIMUS_VERIFIER_XLAYER_TESTNET;
  } else if (network.chainId === 84532n) {
    primusVerifierAddress = PRIMUS_VERIFIER_BASE_SEPOLIA;
  } else {
    throw new Error('Unsupported network. Please use X Layer Testnet (1952) or Base Sepolia (84532)');
  }

  console.log('Using Primus Verifier:', primusVerifierAddress);

  // 1. 部署 PublicKeyRegistry
  console.log('\n=== Deploying PublicKeyRegistry ===');
  const PublicKeyRegistry = await hre.ethers.getContractFactory('PublicKeyRegistry');
  const publicKeyRegistry = await PublicKeyRegistry.deploy();
  await publicKeyRegistry.waitForDeployment();
  const publicKeyRegistryAddress = await publicKeyRegistry.getAddress();
  console.log('PublicKeyRegistry deployed to:', publicKeyRegistryAddress);

  // 2. 部署 zkTLSProofStorage
  console.log('\n=== Deploying zkTLSProofStorage ===');
  const ProofStorage = await hre.ethers.getContractFactory('zkTLSProofStorage');
  const proofStorage = await ProofStorage.deploy(primusVerifierAddress);
  await proofStorage.waitForDeployment();
  const proofStorageAddress = await proofStorage.getAddress();
  console.log('zkTLSProofStorage deployed to:', proofStorageAddress);

  // 3. 部署 AgentRegistry
  console.log('\n=== Deploying AgentRegistry ===');
  const AgentRegistry = await hre.ethers.getContractFactory('AgentRegistry');
  const agentRegistry = await AgentRegistry.deploy(proofStorageAddress);
  await agentRegistry.waitForDeployment();
  const agentRegistryAddress = await agentRegistry.getAddress();
  console.log('AgentRegistry deployed to:', agentRegistryAddress);

  // 4. 部署 SignalEscrow
  console.log('\n=== Deploying SignalEscrow ===');
  const SignalEscrow = await hre.ethers.getContractFactory('SignalEscrow');
  const signalEscrow = await SignalEscrow.deploy(publicKeyRegistryAddress, hre.ethers.ZeroAddress);
  await signalEscrow.waitForDeployment();
  const signalEscrowAddress = await signalEscrow.getAddress();
  console.log('SignalEscrow deployed to:', signalEscrowAddress);

  // 5. 部署 SignalMarket
  console.log('\n=== Deploying SignalMarket ===');
  const SignalMarket = await hre.ethers.getContractFactory('SignalMarket');
  const signalMarket = await SignalMarket.deploy(agentRegistryAddress, proofStorageAddress, signalEscrowAddress);
  await signalMarket.waitForDeployment();
  const signalMarketAddress = await signalMarket.getAddress();
  console.log('SignalMarket deployed to:', signalMarketAddress);

  // 6. 设置 SignalMarket 地址到 AgentRegistry
  console.log('\n=== Setting SignalMarket in AgentRegistry ===');
  const setTx = await agentRegistry.setSignalMarket(signalMarketAddress);
  await setTx.wait();
  console.log('SignalMarket set in AgentRegistry');

  // 7. 设置 SignalMarket 地址到 SignalEscrow
  console.log('\n=== Setting SignalMarket in SignalEscrow ===');
  const setEscrowTx = await signalEscrow.setSignalMarket(signalMarketAddress);
  await setEscrowTx.wait();
  console.log('SignalMarket set in SignalEscrow');

  // 5. 验证部署
  console.log('\n=== Deployment Summary ===');
  console.log({
    zkTLSProofStorage: proofStorageAddress,
    AgentRegistry: agentRegistryAddress,
    SignalMarket: signalMarketAddress,
    PrimusVerifier: primusVerifierAddress,
    Deployer: deployer.address,
    Network: network.name,
    ChainId: network.chainId.toString(),
  });

  // 8. 等待区块确认（用于验证）
  console.log('\nWaiting for block confirmations...');
  await new Promise((resolve) => setTimeout(resolve, 30000)); // 等待 30 秒

  // 9. 尝试验证合约（如果配置了 API Key）
  if (process.env.XLAYER_API_KEY) {
    console.log('\n=== Verifying contracts ===');
    try {
      await hre.run('verify:verify', {
        address: proofStorageAddress,
        constructorArguments: [primusVerifierAddress],
      });
      console.log('zkTLSProofStorage verified');
    } catch (e) {
      console.log('zkTLSProofStorage verification failed:', e.message);
    }

    try {
      await hre.run('verify:verify', {
        address: publicKeyRegistryAddress,
        constructorArguments: [],
      });
      console.log('PublicKeyRegistry verified');
    } catch (e) {
      console.log('PublicKeyRegistry verification failed:', e.message);
    }

    try {
      await hre.run('verify:verify', {
        address: agentRegistryAddress,
        constructorArguments: [proofStorageAddress],
      });
      console.log('AgentRegistry verified');
    } catch (e) {
      console.log('AgentRegistry verification failed:', e.message);
    }

    try {
      await hre.run('verify:verify', {
        address: signalEscrowAddress,
        constructorArguments: [publicKeyRegistryAddress, hre.ethers.ZeroAddress],
      });
      console.log('SignalEscrow verified');
    } catch (e) {
      console.log('SignalEscrow verification failed:', e.message);
    }

    try {
      await hre.run('verify:verify', {
        address: signalMarketAddress,
        constructorArguments: [agentRegistryAddress, proofStorageAddress, signalEscrowAddress],
      });
      console.log('SignalMarket verified');
    } catch (e) {
      console.log('SignalMarket verification failed:', e.message);
    }
  }

  // 10. 保存部署信息到文件
  const deploymentInfo = {
    network: network.name,
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      PublicKeyRegistry: {
        address: publicKeyRegistryAddress,
        constructorArgs: [],
      },
      zkTLSProofStorage: {
        address: proofStorageAddress,
        constructorArgs: [primusVerifierAddress],
      },
      AgentRegistry: {
        address: agentRegistryAddress,
        constructorArgs: [proofStorageAddress],
      },
      SignalEscrow: {
        address: signalEscrowAddress,
        constructorArgs: [publicKeyRegistryAddress, signalMarketAddress],
      },
      SignalMarket: {
        address: signalMarketAddress,
        constructorArgs: [agentRegistryAddress, proofStorageAddress, signalEscrowAddress],
      },
      PrimusVerifier: primusVerifierAddress,
    },
  };

  const fs = require('fs');
  const filename = `./deployments/deployment-${network.chainId.toString()}.json`;
  fs.mkdirSync('./deployments', { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(deploymentInfo, null, 2));
  console.log(`\nDeployment info saved to: ${filename}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
