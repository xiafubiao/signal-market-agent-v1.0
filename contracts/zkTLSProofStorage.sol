// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@primuslabs/zktls-contracts/src/IPrimusZKTLS.sol";

/**
 * @title zkTLSProofStorage
 * @notice 存储 zkTLS attestation 完整数据，提供链上验证入口
 */
contract zkTLSProofStorage is Ownable {
    IPrimusZKTLS public primusVerifier;
    
    struct StoredProof {
        bytes32 proofId;
        address provider;
        bytes32 attestationHash;
        uint256 timestamp;
    }
    
    // proofId => StoredProof
    mapping(bytes32 => StoredProof) public proofs;
    
    // provider => 其所有的 proofIds
    mapping(address => bytes32[]) public providerProofs;
    
    event ProofStored(
        bytes32 indexed proofId,
        address indexed provider,
        uint256 timestamp
    );
    
    constructor(address _primusVerifier) Ownable(msg.sender) {
        require(_primusVerifier != address(0), "Invalid verifier address");
        primusVerifier = IPrimusZKTLS(_primusVerifier);
    }
    
    /**
     * @notice 验证并存储 zkTLS proof（发布信号时调用）
     * @dev 验证 Primus 签名并存储 proof
     * @param attestation Attestation 数据
     * @return proofId 计算出的证明唯一标识
     */
    function verifyAndStore(Attestation calldata attestation) external returns (bytes32) {
        // 1. 验证 Primus 签名（必须提供有效的 attestation）
        primusVerifier.verifyAttestation(attestation);
        
        // 2. 计算 proofId
        bytes32 proofId = keccak256(abi.encode(attestation));
        
        // 3. 检查是否已存在（允许重复存储相同的 proof，因为证明可以复用）
        if (proofs[proofId].timestamp == 0) {
            // 4. 存储 attestation hash
            proofs[proofId] = StoredProof({
                proofId: proofId,
                provider: msg.sender,
                attestationHash: keccak256(abi.encode(attestation)),
                timestamp: block.timestamp
            });
            
            providerProofs[msg.sender].push(proofId);
            
            emit ProofStored(proofId, msg.sender, block.timestamp);
        }
        
        return proofId;
    }
    
    /**
     * @notice 存储新的 zkTLS 证明（单独调用）
     * @param attestation Attestation 数据
     * @return proofId 计算出的证明唯一标识
     */
    function storeProof(Attestation calldata attestation) external returns (bytes32 proofId) {
        // 1. 调用 PrimusVerifier 验证签名有效
        primusVerifier.verifyAttestation(attestation);
        
        // 2. 计算 proofId
        proofId = keccak256(abi.encodePacked(keccak256(abi.encode(attestation)), msg.sender));
        
        // 3. 检查是否已存在
        require(proofs[proofId].timestamp == 0, "Proof already exists");
        
        // 4. 存储 attestation hash
        proofs[proofId] = StoredProof({
            proofId: proofId,
            provider: msg.sender,
            attestationHash: keccak256(abi.encode(attestation)),
            timestamp: block.timestamp
        });
        
        providerProofs[msg.sender].push(proofId);
        
        emit ProofStored(proofId, msg.sender, block.timestamp);
        
        return proofId;
    }
    
    /**
     * @notice 获取完整证明数据
     * @param proofId 证明唯一标识
     */
    function getProof(bytes32 proofId) external view returns (StoredProof memory) {
        require(proofs[proofId].timestamp > 0, "Proof not found");
        return proofs[proofId];
    }
    
    /**
     * @notice 获取 attestation hash
     * @param proofId 证明唯一标识
     */
    function getAttestationHash(bytes32 proofId) external view returns (bytes32) {
        require(proofs[proofId].timestamp > 0, "Proof not found");
        return proofs[proofId].attestationHash;
    }
    
    /**
     * @notice 链上验证证明（Consumer 购买前调用）
     * @param attestation 要验证的 Attestation 数据
     * @return 验证是否通过
     */
    function verifyProofOnChain(Attestation calldata attestation) external view returns (bool) {
        // 调用 PrimusVerifier 验证
        try primusVerifier.verifyAttestation(attestation) {
            return true;
        } catch {
            return false;
        }
    }
    
    /**
     * @notice 检查证明是否存在
     */
    function proofExists(bytes32 proofId) external view returns (bool) {
        return proofs[proofId].timestamp > 0;
    }
    
    /**
     * @notice 获取 Provider 的所有证明
     */
    function getProviderProofs(address provider) external view returns (bytes32[] memory) {
        return providerProofs[provider];
    }
    
    /**
     * @notice 获取 Provider 的最新证明
     */
    function getLatestProofId(address provider) external view returns (bytes32) {
        bytes32[] storage ids = providerProofs[provider];
        if (ids.length == 0) {
            return bytes32(0);
        }
        return ids[ids.length - 1];
    }
    
    /**
     * @notice 更新 Primus Verifier 地址（紧急情况）
     */
    function updateVerifier(address _newVerifier) external onlyOwner {
        require(_newVerifier != address(0), "Invalid address");
        primusVerifier = IPrimusZKTLS(_newVerifier);
    }
}
