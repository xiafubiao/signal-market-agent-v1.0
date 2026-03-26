// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./AgentRegistry.sol";
import "./zkTLSProofStorage.sol";
import "./SignalEscrow.sol";

/**
 * @title SignalMarket
 * @notice Meta 信号发布、交付记录、评分入口 + 购买担保
 */
contract SignalMarket is Ownable {
    AgentRegistry public agentRegistry;
    zkTLSProofStorage public proofStorage;
    SignalEscrow public signalEscrow;
    
    struct Signal {
        uint256 signalId;
        address providerAddress;
        uint256 publishTime;
        bytes32 publishTxHash;
        string metaContent;     // JSON 字符串，包含 instId, side, expireHours, priceAmount, priceToken
        uint256 priceOKB;
        uint256 expireTime;
        bytes32 proofId;        // 发布时的 zkTLS proof hash
        uint256 trustedScore;   // 可信度评分 (0-10 分)
        bool active;
    }
    
    // signalId => Signal
    mapping(uint256 => Signal) public signals;
    
    // provider => 其发布的 signalIds
    mapping(address => uint256[]) public providerSignals;
    
    // signalId => consumer => 是否已交付
    mapping(uint256 => mapping(address => bool)) public deliveries;
    
    // signalId => consumer => 是否已评分
    mapping(uint256 => mapping(address => bool)) public rated;
    
    // signalId => 购买过的 consumer 列表
    mapping(uint256 => address[]) public signalBuyers;
    
    // signalId => 发布交易 hash（链上存储）
    mapping(uint256 => bytes32) public signalPublishTxHash;
    
    // 自增 signalId
    uint256 public nextSignalId;
    
    // 存储活跃信号 ID 列表（用于查询）
    uint256[] public activeSignalIds;
    
    event SignalPublished(
        uint256 indexed signalId,
        address indexed providerAddress,
        uint256 publishTime,
        uint256 priceOKB,
        uint256 expireTime,
        bytes32 txHash
    );
    
    event DeliveryRecorded(
        uint256 indexed signalId,
        address indexed consumer,
        uint256 timestamp
    );
    
    event RatingSubmitted(
        uint256 indexed signalId,
        address indexed consumer,
        uint8 score,
        string comment
    );
    
    event SignalPurchased(
        uint256 indexed signalId,
        uint256 indexed purchaseId,
        address indexed buyer,
        address provider,
        uint256 amount,
        uint256 timestamp
    );
    
    // [修复 #2] getAgent() 只返回单个 Agent memory，不能用元组解构
    modifier onlyRegisteredAgent() {
        require(agentRegistry.isRegistered(msg.sender), "Not registered");
        AgentRegistry.Agent memory agent = agentRegistry.getAgent(msg.sender);
        require(agent.active, "Agent not active");
        _;
    }
    
    constructor(
        address _agentRegistry,
        address _proofStorage,
        address _signalEscrow
    ) Ownable(msg.sender) {
        require(_agentRegistry != address(0), "Invalid registry address");
        require(_proofStorage != address(0), "Invalid proof storage address");
        require(_signalEscrow != address(0), "Invalid escrow address");
        
        agentRegistry = AgentRegistry(_agentRegistry);
        proofStorage = zkTLSProofStorage(_proofStorage);
        signalEscrow = SignalEscrow(_signalEscrow);
        nextSignalId = 0;  // 从 0 开始
    }
    
    /**
     * @notice 发布新的 Meta 信号（需附带 zkTLS proof 证明交易能力）
     * @param signalId 信号唯一 ID（由前端生成，8 字符 hex 字符串的 uint256 表示）
     * @param metaContent 信号元数据（JSON 字符串）
     * @param priceOKB 价格（以 OKB 计，18 位小数）
     * @param expireHours 过期时间（小时）
     * @param attestation zkTLS attestation，证明最近的交易 PnL
     * @param publishTxHash 发布交易 hash（由前端传入）
     */
    function publishSignal(
        uint256 trustedScore,
        uint256 signalId,
        string calldata metaContent,
        uint256 priceOKB,
        uint256 expireHours,
        Attestation calldata attestation,
        bytes32 publishTxHash
    ) external onlyRegisteredAgent returns (uint256) {
        require(bytes(metaContent).length > 0, "Meta content cannot be empty");
        require(priceOKB > 0, "Price must be greater than 0");
        require(expireHours > 0, "Expire hours must be greater than 0");
        require(trustedScore <= 10, "Trusted score must be <= 10");
        require(signalId > 0, "Invalid signalId");
        require(signals[signalId].signalId == 0, "Signal already exists");
        
        // 验证 attestation 签名
        proofStorage.verifyAndStore(attestation);
        // 注：Primus SDK 不设置 recipient，跳过此检查
        // require(attestation.recipient == msg.sender, "Proof recipient mismatch");
        
        // 计算 proofId
        bytes32 proofId = keccak256(abi.encode(attestation));
        
        uint256 expireTime = block.timestamp + expireHours * 3600;
        
        // 使用传入的 signalId
        signalPublishTxHash[signalId] = publishTxHash;
        
        signals[signalId] = Signal({
            signalId: signalId,
            providerAddress: msg.sender,
            publishTime: block.timestamp,
            publishTxHash: publishTxHash,
            metaContent: metaContent,
            priceOKB: priceOKB,
            expireTime: expireTime,
            proofId: proofId,
            trustedScore: trustedScore,
            active: true
        });
        
        providerSignals[msg.sender].push(signalId);
        activeSignalIds.push(signalId);
        
        emit SignalPublished(
            signalId,
            msg.sender,
            block.timestamp,
            priceOKB,
            expireTime,
            publishTxHash
        );
        
        return signalId;
    }
    
    /**
     * @notice Consumer 购买信号（支付 OKB 到担保合约）
     * @param signalId 信号 ID
     * @param buyerPublicKey Buyer 的 ECIES 公钥（用于接收加密内容）
     */
    function purchaseSignal(uint256 signalId, string calldata buyerPublicKey) external payable onlyRegisteredAgent returns (uint256 purchaseId) {
        Signal storage signal = signals[signalId];
        require(signal.signalId == signalId, "Signal not found");
        require(signal.active, "Signal not active");
        require(block.timestamp <= signal.expireTime, "Signal expired");
        require(msg.value == signal.priceOKB, "Incorrect payment amount");
        require(msg.sender != signal.providerAddress, "Cannot buy own signal");
        
        // 记录购买
        signalBuyers[signalId].push(msg.sender);
        
        // 调用担保合约（将 OKB 转入担保，传入实际 buyer 地址）
        purchaseId = signalEscrow.purchase{value: msg.value}(signalId, signal.providerAddress, msg.sender, buyerPublicKey);
        
        emit SignalPurchased(signalId, purchaseId, msg.sender, signal.providerAddress, msg.value, block.timestamp);
        
        return purchaseId;
    }
    
    /**
     * @notice Provider 记录交付（调用担保合约提交加密内容）
     * @param purchaseId 购买 ID
     * @param encryptedContent ECIES 加密的信号内容（Base64 编码）
     */
    function recordDelivery(uint256 purchaseId, string calldata encryptedContent) external onlyRegisteredAgent {
        // 通过担保合约交付加密内容
        signalEscrow.deliver(purchaseId, encryptedContent);
        
        // 获取购买详情记录交付状态
        (uint256 signalId, address consumer,,,,,,,) = signalEscrow.getPurchase(purchaseId);
        deliveries[signalId][consumer] = true;
        
        emit DeliveryRecorded(signalId, consumer, block.timestamp);
    }
    
    /**
     * @notice Agent 提交评分
     */
    function submitRating(
        uint256 signalId,
        uint8 score,
        string calldata comment
    ) external onlyRegisteredAgent {
        require(score >= 1 && score <= 5, "Score must be between 1 and 5");
        
        Signal storage signal = signals[signalId];
        require(signal.signalId == signalId, "Signal not found");
        
        // 必须有交付记录
        require(deliveries[signalId][msg.sender], "No delivery record");
        
        // 信号必须已过期
        require(block.timestamp > signal.expireTime, "Signal not expired yet");
        
        // 未重复评分
        require(!rated[signalId][msg.sender], "Already rated");
        
        rated[signalId][msg.sender] = true;
        
        // 更新 Provider 信誉分
        agentRegistry.updateReputation(signal.providerAddress, score);
        
        emit RatingSubmitted(signalId, msg.sender, score, comment);
    }
    
    /**
     * @notice 获取单条信号
     */
    function getSignal(uint256 signalId) external view returns (Signal memory) {
        require(signals[signalId].signalId == signalId, "Signal not found");
        return signals[signalId];
    }
    
    /**
     * @notice 获取某 Provider 发布的所有信号
     */
    function getSignalsByProvider(address provider) external view returns (Signal[] memory) {
        uint256[] storage ids = providerSignals[provider];
        Signal[] memory result = new Signal[](ids.length);
        
        for (uint i = 0; i < ids.length; i++) {
            result[i] = signals[ids[i]];
        }
        
        return result;
    }
    
    /**
     * @notice 获取所有活跃信号
     * @dev MVP 版本，信号量大时需要分页
     */
    function getActiveSignals() external view returns (Signal[] memory) {
        uint256 count = 0;
        
        // 先计算有效信号数量
        for (uint i = 0; i < activeSignalIds.length; i++) {
            Signal storage signal = signals[activeSignalIds[i]];
            if (signal.active && signal.expireTime > block.timestamp) {
                count++;
            }
        }
        
        Signal[] memory result = new Signal[](count);
        uint256 index = 0;
        
        // 填充结果数组
        for (uint i = 0; i < activeSignalIds.length; i++) {
            Signal storage signal = signals[activeSignalIds[i]];
            if (signal.active && signal.expireTime > block.timestamp) {
                result[index] = signal;
                index++;
            }
        }
        
        return result;
    }
    
    /**
     * @notice 检查是否已交付
     */
    function hasDelivery(uint256 signalId, address consumer) external view returns (bool) {
        return deliveries[signalId][consumer];
    }
    
    /**
     * @notice 获取信号的发布交易 hash
     */
    function getSignalPublishTxHash(uint256 signalId) external view returns (bytes32) {
        require(signals[signalId].signalId == signalId, "Signal not found");
        return signalPublishTxHash[signalId];
    }
    
    /**
     * @notice 检查是否已评分
     */
    function hasRated(uint256 signalId, address consumer) external view returns (bool) {
        return rated[signalId][consumer];
    }
    
    /**
     * @notice 获取某信号的购买者列表
     */
    function getSignalBuyers(uint256 signalId) external view returns (address[] memory) {
        return signalBuyers[signalId];
    }
    
    /**
     * @notice 获取购买详情
     */
    function getPurchaseDetails(uint256 purchaseId) external view returns (
        uint256 signalId,
        address buyer,
        address provider,
        uint256 amount,
        bool delivered,
        bool confirmed
    ) {
        (
            signalId,
            buyer,
            provider,
            amount,
            ,
            ,
            delivered,
            confirmed,
           
        ) = signalEscrow.getPurchase(purchaseId);
    }
    
    /**
     * @notice 设置担保合约地址（紧急情况）
     */
    function setSignalEscrow(address _newEscrow) external onlyOwner {
        require(_newEscrow != address(0), "Invalid address");
        signalEscrow = SignalEscrow(_newEscrow);
    }

    // [修复 #1] 以下函数原来游离在合约括号外，已移入合约内

    /**
     * @notice 获取信号数量
     */
    function getSignalCount() external view returns (uint256) {
        return nextSignalId - 1;
    }
    
    /**
     * @notice 获取活跃信号 ID 列表
     */
    function getActiveSignalIds() external view returns (uint256[] memory) {
        return activeSignalIds;
    }
    
    /**
     * @notice 信号过期后自动失效（清理函数）
     * @dev 可由任何人调用，用于清理过期信号
     */
    function deactivateExpiredSignal(uint256 signalId) external {
        Signal storage signal = signals[signalId];
        require(signal.signalId == signalId, "Signal not found");
        require(block.timestamp > signal.expireTime, "Signal not expired");
        require(signal.active, "Already inactive");
        
        signal.active = false;
    }
    
    /**
     * @notice Provider 主动撤销信号
     */
    function revokeSignal(uint256 signalId) external {
        Signal storage signal = signals[signalId];
        require(signal.signalId == signalId, "Signal not found");
        require(signal.providerAddress == msg.sender, "Not the provider");
        require(signal.active, "Already inactive");
        require(block.timestamp <= signal.expireTime, "Signal already expired");
        
        signal.active = false;
    }
}
