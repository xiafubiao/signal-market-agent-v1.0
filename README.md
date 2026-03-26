# Signal Market Agent

Decentralized Signal Trading Platform - zkTLS Verified Trusted Signal Market


zkTLS is a powerful cryptography technolog that allows anyone to prove his web data through TLS protocols, while the data authenticity is always ensured. We use Primus zkTLS in this project to prove any trader's off-chain balance, kyc information and latest PnL data,  to improve the credibility of his published trading signal.  

The signal market integrates with OKX onchainos features, inclduing okx-dex-market and okx-dex-signal, to ensure the live market data to be reachable.

To use this signal market agent, you need to configure with your LLM to activate the natural language interaction feature.

## 🌟 Features

- **Decentralized Signal Trading**: Providers publish trading signals, Consumers purchase and view
- **zkTLS Verification**: Verify Provider's real trading records through zero-knowledge proofs
- **Trusted Score**: Automatic rating system based on account balance, KYC level, and trading performance
- **Encrypted Signal Content**: ECIES encryption, only buyers can decrypt and view
- **Smart Contract Escrow**: Funds held in smart contract escrow for secure transactions
- **Natural Language Interaction**: AI Agent supports natural language commands

## 📁 Project Structure

```
signal-market-agent/
├── contracts/              # Solidity Smart Contracts
│   ├── AgentRegistry.sol   # Agent Registry Contract
│   ├── SignalMarket.sol    # Signal Market Main Contract
│   ├── SignalEscrow.sol    # Fund Escrow Contract
│   ├── zkTLSProofStorage.sol  # zkTLS Proof Storage
│   └── PublicKeyRegistry.sol  # Public Key Registry
├── signal-agent/           # Node.js Backend Service
│   ├── src/               # Source Code
│   │   ├── toolAgent.js   # AI Agent Main Logic
│   │   ├── trustedScore.js # Trusted Score Calculator
│   │   ├── primusZkTLS.js # zkTLS Proof Generator
│   │   ├── encryptedSignalService.js # Encrypted Signal Service
│   │   └── ...
│   ├── public/            # Frontend Web UI
│   │   └── index.html     # Single Page Application
│   ├── start-webui.js     # Web UI Launch Script
│   └── .env.example       # Configuration Template
├── scripts/               # Deployment Scripts
│   └── deploy.js          # Contract Deployment Script
└── hardhat.config.js      # Hardhat Configuration
```

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd signal-agent
npm install
```

### 2. Configure Environment Variables

```bash
cp .env.example .env
# Edit .env and fill in configuration
```

### 3. Start Web UI

```bash
node start-webui.js
```

Visit http://localhost:3000

### 4. Deploy Contracts (Optional)

```bash
cd ..
npx hardhat run scripts/deploy.js --network xlayer_testnet
```

## 📋 Configuration Guide

### Required Configuration

| Variable | Description |
|------|------|
| `AGENT_REGISTRY_ADDRESS` | AgentRegistry Contract Address |
| `SIGNAL_MARKET_ADDRESS` | SignalMarket Contract Address |
| `PROVIDER_PRIVATE_KEY` | Provider Wallet Private Key |
| `CONSUMER_PRIVATE_KEY` | Consumer Wallet Private Key |
| `OKX_API_KEY` | OKX API Key |
| `OKX_SECRET_KEY` | OKX Secret Key |
| `OKX_PASSPHRASE` | OKX Passphrase |
| `PRIMUS_APP_ID` | Primus App ID |
| `PRIMUS_APP_SECRET` | Primus App Secret |
| `LLM_API_KEY` | LLM API Key |

### Network Configuration

Default: **XLayer Testnet**:
- Chain ID: 1952
- RPC: https://testrpc.xlayer.tech/terigon
- Explorer: https://www.oklink.com/xlayer-test

You can switch to XLayer Mainnet with proper configuration of Chain ID and RPC endpoint.



## 🔐 Trusted Score Rating System

Automatically calculates Provider credibility based on zkTLS Proof:

| Dimension | Weight | Scoring Criteria |
|------|------|---------|
| Account Balance | 3 points | <$1k→1 pt, $1k-$10k→2 pts, >$10k→3 pts |
| KYC Level | 3 points | Lv<2→1 pt, Lv2→2 pts, Lv>2→3 pts |
| Trading PnL | 4 points | \|PNL\|<$100→1 pt, $100-$500→2 pts, $500-$1k→3 pts, >$1k→4 pts |
| Currency Consistency | -1 point | -1 pt if PnL currency differs from signal currency |

**Total Score**: 0-10 points  
**Rating**: Excellent(≥10), Good(7-9), Fair(4-6), Poor(<4)

## 💡 Main Features

### Provider Operations
- Register Agent
- Publish encrypted signals (with zkTLS proof)
- Deliver signal content

### Consumer Operations
- Browse signal list (displays Trusted Score)
- Purchase signals
- Decrypt and view signal content
- Confirm delivery and rate

### AI Agent Interaction
Supports natural language commands:
- "Publish a BTC signal"
- "View available signals"
- "Purchase the first signal"
- "Check configuration status"

## 🛠️ Tech Stack

- **Smart Contracts**: Solidity 0.8.20, Hardhat
- **Backend**: Node.js, ethers.js v6
- **Frontend**: Vanilla JS, HTML5, CSS3
- **zkTLS**: Primus Labs zktls-core-sdk
- **Encryption**: ECIES (Elliptic Curve Integrated Encryption Scheme)
- **AI**: Qwen (qwen-plus)

## 📝 Contract Deployment Addresses

### XLayer Testnet

| Contract | Address |
|------|------|
| AgentRegistry | `0x6bA0a95F125AaDCB9122fb1C169F222d667df292` |
| SignalMarket | `0xBb1C407Daf6051f2fACFD4ac59b698f03cD2C4E1` |
| SignalEscrow | `0xfFEF0f9031856C2eD3F0ED04b28d91D03B6D40EF` |
| zkTLSProofStorage | `0x9fe80B4F7905E6E681B60C7e45DBd5aA5Fd3bCE2` |
| PublicKeyRegistry | `0x12534FDaE9B80F586d816F7e152A10d71188A33D` |

## ⚠️ Important Notes

1. **Private Key Security**: Never commit `.env` files to Git
2. **Test Network**: Default is XLayer Testnet, switch to mainnet for production
3. **API Permissions**: OKX API Key needs permissions to read account balance and transaction history
4. **Gas Fees**: Ensure wallet has sufficient OKB for gas payments

## 📄 License

MIT

## 🤝 Contributing

Issues and Pull Requests are welcome!
