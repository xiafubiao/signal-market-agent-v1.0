// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IPublicKeyRegistry {
    function getPublicKey(address user) external view returns (string memory);
    function isRegistered(address user) external view returns (bool);
}

/**
 * @title SignalEscrow
 * @dev 信号购买担保合约（使用原生代币 OKB/ETH）
 * 
 * 购买流程：
 * 1. Buyer 调用 purchase() 将 OKB 打入合约（msg.value）
 * 2. Provider 轮询 getPendingDeliveries() 获取待交付的购买
 * 3. Provider 用 Buyer 公钥加密信号内容后调用 deliver() 提交加密数据
 * 4. Buyer 轮询 getEncryptedSignals() 获取加密内容
 * 5. Buyer 本地解密后调用 confirmDelivery() 释放资金给 Provider
 */
contract SignalEscrow {
    address public signalMarket;
    
    struct Purchase {
        uint256 purchaseId;
        uint256 signalId;
        address buyer;
        address provider;
        uint256 amount;
        string buyerPublicKey;  // Buyer 的公钥（购买时提供）
        uint256 timestamp;
        bool delivered;
        bool confirmed;
        bool refunded;
    }
    
    struct EncryptedSignal {
        uint256 purchaseId;
        uint256 signalId;
        address buyer;
        address provider;
        string encryptedContent;  // ECIES 加密的内容
        uint256 deliverTimestamp;
    }
    
    // 公钥注册合约地址
    address public publicKeyRegistry;
    
    // purchaseId => Purchase
    mapping(uint256 => Purchase) public purchases;
    
    // purchaseId => EncryptedSignal
    mapping(uint256 => EncryptedSignal) public encryptedSignals;
    
    // buyer => purchaseId[]
    mapping(address => uint256[]) public buyerPurchases;
    
    // provider => purchaseId[]
    mapping(address => uint256[]) public providerSales;
    
    // signalId => purchaseId[]
    mapping(uint256 => uint256[]) public signalPurchases;
    
    uint256 public nextPurchaseId;
    
    modifier onlySignalMarket() {
        require(msg.sender == signalMarket, "Only SignalMarket can call");
        _;
    }
    
    // Events
    event PurchaseCreated(
        uint256 indexed purchaseId,
        uint256 indexed signalId,
        address indexed buyer,
        address provider,
        uint256 amount,
        string buyerPublicKey,
        uint256 timestamp
    );
    
    event SignalDelivered(
        uint256 indexed purchaseId,
        uint256 indexed signalId,
        address indexed provider,
        address buyer,
        uint256 timestamp
    );
    
    event DeliveryConfirmed(
        uint256 indexed purchaseId,
        address indexed buyer,
        address provider,
        uint256 amount
    );
    
    event PurchaseRefunded(
        uint256 indexed purchaseId,
        address indexed buyer,
        uint256 amount
    );
    
    constructor(address _publicKeyRegistry, address _signalMarket) {
        publicKeyRegistry = _publicKeyRegistry;
        signalMarket = _signalMarket;
    }
    
    /**
     * @dev 购买信号 - 只能由 SignalMarket 调用（资金来自 Buyer）
     * @param signalId 信号 ID
     * @param provider Provider 地址
     * @param buyer Buyer 地址（实际购买者）
     * @param buyerPublicKey Buyer 的 ECIES 公钥（64 字节 hex 字符串，不带 0x 前缀）
     */
    function purchase(
        uint256 signalId,
        address provider,
        address buyer,
        string calldata buyerPublicKey
    ) external payable onlySignalMarket returns (uint256) {
        require(msg.value > 0, "Amount must be > 0");
        require(provider != address(0), "Invalid provider");
        require(buyer != address(0), "Invalid buyer");
        require(bytes(buyerPublicKey).length == 128, "Invalid public key length");
        
        uint256 purchaseId = nextPurchaseId++;
        
        purchases[purchaseId] = Purchase({
            purchaseId: purchaseId,
            signalId: signalId,
            buyer: buyer,
            provider: provider,
            amount: msg.value,
            buyerPublicKey: buyerPublicKey,
            timestamp: block.timestamp,
            delivered: false,
            confirmed: false,
            refunded: false
        });
        
        buyerPurchases[buyer].push(purchaseId);
        providerSales[provider].push(purchaseId);
        signalPurchases[signalId].push(purchaseId);
        
        emit PurchaseCreated(purchaseId, signalId, buyer, provider, msg.value, buyerPublicKey, block.timestamp);
        
        return purchaseId;
    }
    
    /**
     * @dev 交付加密信号 - Provider 调用（或通过 SignalMarket 调用）
     * @param purchaseId 购买 ID
     * @param encryptedContent ECIES 加密的信号内容（Base64 编码）
     */
    function deliver(
        uint256 purchaseId,
        string calldata encryptedContent
    ) external {
        Purchase storage p = purchases[purchaseId];
        
        // 允许 Provider 直接调用，或 SignalMarket 合约调用
        require(msg.sender == p.provider || msg.sender == signalMarket, "Only provider can deliver");
        require(!p.delivered, "Already delivered");
        require(!p.refunded, "Purchase refunded");
        require(bytes(encryptedContent).length > 0, "Empty content");
        
        p.delivered = true;
        
        encryptedSignals[purchaseId] = EncryptedSignal({
            purchaseId: purchaseId,
            signalId: p.signalId,
            buyer: p.buyer,
            provider: msg.sender == p.provider ? msg.sender : p.provider,
            encryptedContent: encryptedContent,
            deliverTimestamp: block.timestamp
        });
        
        emit SignalDelivered(purchaseId, p.signalId, msg.sender, p.buyer, block.timestamp);
    }
    
    /**
     * @dev 确认交付 - Buyer 调用
     * @param purchaseId 购买 ID
     */
    function confirmDelivery(uint256 purchaseId) external {
        Purchase storage p = purchases[purchaseId];
        
        require(msg.sender == p.buyer, "Only buyer can confirm");
        require(p.delivered, "Not delivered yet");
        require(!p.confirmed, "Already confirmed");
        require(!p.refunded, "Purchase refunded");
        
        p.confirmed = true;
        
        // 释放资金给 Provider（原生代币）
        (bool success, ) = payable(p.provider).call{value: p.amount}("");
        require(success, "Transfer to provider failed");
        
        emit DeliveryConfirmed(purchaseId, msg.sender, p.provider, p.amount);
    }
    
    /**
     * @dev 超时退款 - Buyer 调用（如果 Provider 未按时交付）
     * @param purchaseId 购买 ID
     * @param timeoutSeconds 超时时间（秒）
     */
    function refund(uint256 purchaseId, uint256 timeoutSeconds) external {
        Purchase storage p = purchases[purchaseId];
        
        require(msg.sender == p.buyer, "Only buyer can refund");
        require(!p.delivered, "Already delivered");
        require(!p.refunded, "Already refunded");
        require(
            block.timestamp >= p.timestamp + timeoutSeconds,
            "Timeout not reached"
        );
        
        p.refunded = true;
        
        // 退款给 Buyer（原生代币）
        (bool success, ) = payable(p.buyer).call{value: p.amount}("");
        require(success, "Refund transfer failed");
        
        emit PurchaseRefunded(purchaseId, msg.sender, p.amount);
    }
    
    /**
     * @dev 获取 Buyer 的所有购买
     */
    function getBuyerPurchases(address buyer) external view returns (uint256[] memory) {
        return buyerPurchases[buyer];
    }
    
    /**
     * @dev 获取 Provider 的所有销售
     */
    function getProviderSales(address provider) external view returns (uint256[] memory) {
        return providerSales[provider];
    }
    
    /**
     * @dev 获取待交付的购买（Provider 轮询用）
     * @param provider Provider 地址
     */
    function getPendingDeliveries(address provider) external view returns (uint256[] memory) {
        uint256[] memory allSales = providerSales[provider];
        uint256 pendingCount = 0;
        
        // 计算待交付数量
        for (uint256 i = 0; i < allSales.length; i++) {
            Purchase storage p = purchases[allSales[i]];
            if (!p.delivered && !p.refunded) {
                pendingCount++;
            }
        }
        
        // 返回待交付的 purchaseId
        uint256[] memory pending = new uint256[](pendingCount);
        uint256 index = 0;
        for (uint256 i = 0; i < allSales.length; i++) {
            Purchase storage p = purchases[allSales[i]];
            if (!p.delivered && !p.refunded) {
                pending[index++] = allSales[i];
            }
        }
        
        return pending;
    }
    
    /**
     * @dev 获取 Buyer 待下载的加密信号
     * @param buyer Buyer 地址
     */
    function getEncryptedSignals(address buyer) external view returns (uint256[] memory) {
        uint256[] memory allPurchases = buyerPurchases[buyer];
        uint256 encryptedCount = 0;
        
        // 计算已交付但未确认的数量
        for (uint256 i = 0; i < allPurchases.length; i++) {
            Purchase storage p = purchases[allPurchases[i]];
            if (p.delivered && !p.confirmed && !p.refunded) {
                encryptedCount++;
            }
        }
        
        // 返回已交付的 purchaseId
        uint256[] memory encrypted = new uint256[](encryptedCount);
        uint256 index = 0;
        for (uint256 i = 0; i < allPurchases.length; i++) {
            Purchase storage p = purchases[allPurchases[i]];
            if (p.delivered && !p.confirmed && !p.refunded) {
                encrypted[index++] = allPurchases[i];
            }
        }
        
        return encrypted;
    }
    
    /**
     * @dev 获取购买详情
     */
    function getPurchase(uint256 purchaseId) external view returns (
        uint256 signalId,
        address buyer,
        address provider,
        uint256 amount,
        string memory buyerPublicKey,
        uint256 timestamp,
        bool delivered,
        bool confirmed,
        bool refunded
    ) {
        Purchase storage p = purchases[purchaseId];
        return (
            p.signalId,
            p.buyer,
            p.provider,
            p.amount,
            p.buyerPublicKey,
            p.timestamp,
            p.delivered,
            p.confirmed,
            p.refunded
        );
    }
    
    /**
     * @dev 获取加密信号内容
     */
    function getEncryptedContent(uint256 purchaseId) external view returns (
        string memory encryptedContent,
        uint256 deliverTimestamp
    ) {
        EncryptedSignal storage e = encryptedSignals[purchaseId];
        return (e.encryptedContent, e.deliverTimestamp);
    }
    
    /**
     * @dev 更新 SignalMarket 地址（初始化时调用）
     */
    function setSignalMarket(address _newMarket) external {
        require(signalMarket == address(0) || msg.sender == signalMarket, "Cannot set SignalMarket");
        require(_newMarket != address(0), "Invalid address");
        signalMarket = _newMarket;
    }
}
