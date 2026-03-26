import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

/**
 * Agent 配置管理器
 * 支持通过自然语言配置环境
 */

const ENV_PATH = path.join(process.cwd(), '.env');

export class ConfigManager {
  constructor() {
    this.configs = {};
    this.load();
  }
  
  // 加载配置
  load() {
    try {
      if (fs.existsSync(ENV_PATH)) {
        const envContent = fs.readFileSync(ENV_PATH, 'utf-8');
        const parsed = dotenv.parse(envContent);
        this.configs = parsed;
        console.log('✅ Configuration loaded');
      } else {
        console.log('⚠️  .env 文件不存在，将创建新文件');
        this.configs = {};
      }
    } catch (e) {
      console.error('❌ 加载配置失败:', e.message);
      this.configs = {};
    }
  }
  
  // 保存配置
  save() {
    try {
      let content = '# Signal Agent Configuration\n\n';
      
      // 钱包配置
      content += '# ── 钱包配置 ───────────────────────────────────────────\n';
      content += `PROVIDER_PRIVATE_KEY=${this.configs.PROVIDER_PRIVATE_KEY || ''}\n`;
      content += `PROVIDER_ADDRESS=${this.configs.PROVIDER_ADDRESS || ''}\n`;
      content += `CONSUMER_PRIVATE_KEY=${this.configs.CONSUMER_PRIVATE_KEY || ''}\n`;
      content += `CONSUMER_ADDRESS=${this.configs.CONSUMER_ADDRESS || ''}\n\n`;
      
      // OKX 配置
      content += '# ── OKX API 配置 ───────────────────────────────────────\n';
      content += `OKX_API_KEY=${this.configs.OKX_API_KEY || ''}\n`;
      content += `OKX_SECRET_KEY=${this.configs.OKX_SECRET_KEY || ''}\n`;
      content += `OKX_PASSPHRASE=${this.configs.OKX_PASSPHRASE || ''}\n\n`;
      
      // Primus 配置
      content += '# ── Primus zkTLS 配置 ──────────────────────────────────\n';
      content += `PRIMUS_APP_ID=${this.configs.PRIMUS_APP_ID || ''}\n`;
      content += `PRIMUS_APP_SECRET=${this.configs.PRIMUS_APP_SECRET || ''}\n\n`;
      
      // LLM 配置
      content += '# ── LLM 配置 ───────────────────────────────────────────\n';
      content += `LLM_API_KEY=${this.configs.LLM_API_KEY || ''}\n`;
      content += `LLM_MODEL=${this.configs.LLM_MODEL || 'qwen-plus'}\n\n`;
      
      // 合约配置
      content += '# ── 合约地址 ───────────────────────────────────────────\n';
      content += `AGENT_REGISTRY_ADDRESS=${this.configs.AGENT_REGISTRY_ADDRESS || ''}\n`;
      content += `SIGNAL_MARKET_ADDRESS=${this.configs.SIGNAL_MARKET_ADDRESS || ''}\n`;
      content += `PROOF_STORAGE_ADDRESS=${this.configs.PROOF_STORAGE_ADDRESS || ''}\n\n`;
      
      // 其他配置
      content += '# ── 其他配置 ───────────────────────────────────────────\n';
      content += `XLAYER_RPC_URL=${this.configs.XLAYER_RPC_URL || 'https://testrpc.xlayer.tech/terigon'}\n`;
      content += `XLAYER_CHAIN_ID=${this.configs.XLAYER_CHAIN_ID || '1952'}\n`;
      content += `SERVICE_PORT=${this.configs.SERVICE_PORT || '3000'}\n`;
      
      fs.writeFileSync(ENV_PATH, content);
      console.log('✅ 配置已保存');
      
      // 重新加载环境变量
      Object.entries(this.configs).forEach(([key, value]) => {
        if (value) process.env[key] = value;
      });
      
      return { success: true, message: '✅ 配置已保存' };
    } catch (e) {
      console.error('❌ 保存配置失败:', e.message);
      return { success: false, error: e.message };
    }
  }
  
  // 更新配置
  update(key, value) {
    this.configs[key] = value;
    return this.save();
  }
  
  // 获取配置
  get(key) {
    return this.configs[key];
  }
  
  // 获取所有配置（隐藏敏感信息）
  getSafeConfig() {
    const safe = {};
    Object.keys(this.configs).forEach(key => {
      const value = this.configs[key];
      if (value) {
        // 隐藏敏感信息
        if (key.includes('KEY') || key.includes('SECRET') || key.includes('PRIVATE')) {
          safe[key] = value.length > 10 ? value.substring(0, 6) + '...' + value.substring(value.length - 4) : '***';
        } else {
          safe[key] = value;
        }
      }
    });
    return safe;
  }
  
  // 检查配置是否完整
  checkStatus() {
    const required = {
      '钱包配置': ['PROVIDER_PRIVATE_KEY'],
      'OKX API': ['OKX_API_KEY', 'OKX_SECRET_KEY', 'OKX_PASSPHRASE'],
      'Primus zkTLS': ['PRIMUS_APP_ID', 'PRIMUS_APP_SECRET'],
      'LLM': ['LLM_API_KEY']
    };
    
    const status = {
      complete: true,
      missing: [],
      sections: {}
    };
    
    Object.entries(required).forEach(([section, keys]) => {
      const missing = keys.filter(key => !this.configs[key]);
      status.sections[section] = missing.length === 0;
      if (missing.length > 0) {
        status.complete = false;
        status.missing.push(...missing);
      }
    });
    
    return status;
  }
}

export default ConfigManager;
