require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config();

// 添加时间操作辅助函数
const { time } = require('@nomicfoundation/hardhat-network-helpers');

// 获取私钥并添加 0x 前缀（如果需要）
let privateKey = process.env.PRIVATE_KEY || '';
if (privateKey && !privateKey.startsWith('0x')) {
  privateKey = '0x' + privateKey;
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.20',
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      forking: {
        url: process.env.XLAYER_TESTNET_RPC || 'https://testrpc.xlayer.tech/terigon',
        enabled: false,
      },
    },
    xlayer_testnet: {
      // ✅ 使用 OKX 官方测试网 RPC
      url: process.env.XLAYER_TESTNET_RPC || 'https://testrpc.xlayer.tech/terigon',
      accounts: privateKey ? [privateKey] : [],
      chainId: 1952,  // ✅ X Layer Testnet Chain ID = 1952 (0x7A0)
    },
    xlayer_mainnet: {
      url: process.env.XLAYER_MAINNET_RPC || 'https://rpc.xlayer.tech',
      accounts: privateKey ? [privateKey] : [],
      chainId: 196,
    },
    base_sepolia: {
      url: process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org',
      accounts: privateKey ? [privateKey] : [],
      chainId: 84532,
    },
  },
  etherscan: {
    apiKey: {
      xlayer_testnet: process.env.XLAYER_API_KEY || '',
      xlayer_mainnet: process.env.XLAYER_API_KEY || '',
    },
    customChains: [
      {
        network: 'xlayer_testnet',
        chainId: 1952,
        urls: {
          apiURL: 'https://www.oklink.com/api/v5/explorer/contract/verify-source-code',
          browserURL: 'https://www.oklink.com/xlayer-test',
        },
      },
      {
        network: 'xlayer_mainnet',
        chainId: 196,
        urls: {
          apiURL: 'https://www.oklink.com/api/v5/explorer/contract/verify-source-code',
          browserURL: 'https://www.oklink.com/xlayer',
        },
      },
    ],
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: 'USD',
  },
  paths: {
    sources: './contracts',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },
  mocha: {
    timeout: 100000,
  },
};

// 导出 time 供测试使用
global.time = time;
