// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title PublicKeyRegistry
 * @dev 公钥注册合约
 * 
 * 用户注册自己的 ECIES 公钥，用于接收加密信号
 * 公钥格式：64 字节（ uncompressed public key without 0x04 prefix）
 */
contract PublicKeyRegistry {
    
    // address => publicKey (64 bytes, hex string without 0x prefix)
    mapping(address => string) public publicKeys;
    
    // address => registration timestamp
    mapping(address => uint256) public registrationTime;
    
    event PublicKeyRegistered(
        address indexed user,
        string publicKey,
        uint256 timestamp
    );
    
    event PublicKeyUpdated(
        address indexed user,
        string oldPublicKey,
        string newPublicKey,
        uint256 timestamp
    );
    
    /**
     * @dev 注册公钥
     * @param publicKey ECIES 公钥（64 字节 hex 字符串，不带 0x 前缀）
     */
    function registerPublicKey(string calldata publicKey) external {
        require(bytes(publicKey).length == 128, "Invalid public key length");
        
        string memory existingKey = publicKeys[msg.sender];
        
        if (bytes(existingKey).length == 0) {
            // 新注册
            publicKeys[msg.sender] = publicKey;
            registrationTime[msg.sender] = block.timestamp;
            
            emit PublicKeyRegistered(msg.sender, publicKey, block.timestamp);
        } else {
            // 更新
            publicKeys[msg.sender] = publicKey;
            
            emit PublicKeyUpdated(msg.sender, existingKey, publicKey, block.timestamp);
        }
    }
    
    /**
     * @dev 获取用户的公钥
     * @param user 用户地址
     */
    function getPublicKey(address user) external view returns (string memory) {
        return publicKeys[user];
    }
    
    /**
     * @dev 检查用户是否已注册公钥
     * @param user 用户地址
     */
    function isRegistered(address user) external view returns (bool) {
        return bytes(publicKeys[user]).length > 0;
    }
    
    /**
     * @dev 批量获取公钥（用于 Provider 批量加密）
     * @param users 用户地址数组
     */
    function getPublicKeys(address[] calldata users) external view returns (string[] memory) {
        string[] memory keys = new string[](users.length);
        for (uint256 i = 0; i < users.length; i++) {
            keys[i] = publicKeys[users[i]];
        }
        return keys;
    }
}
