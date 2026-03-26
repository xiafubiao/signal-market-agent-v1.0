// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./zkTLSProofStorage.sol";

contract AgentRegistry is Ownable {
    zkTLSProofStorage public proofStorage;
    address public signalMarketContract;
    
    struct Agent {
        string name;
        address walletAddress;
        bytes32 latestProofId;
        uint256 reputationScore;
        uint256 totalRatings;
        bool active;
        uint256 registeredAt;
    }
    
    mapping(address => Agent) public agents;
    mapping(address => bool) public isRegistered;
    
    bool public signalMarketSet;
    
    event AgentRegistered(address indexed walletAddress, string name);
    event AttestationUpdated(address indexed agent, bytes32 newProofId);
    event ReputationUpdated(address indexed agent, uint8 score, uint256 newReputationScore);
    
    modifier onlySignalMarket() {
        require(msg.sender == signalMarketContract, "Only SignalMarket can call");
        _;
    }
    
    modifier onlyRegistered() {
        require(isRegistered[msg.sender], "Agent not registered");
        _;
    }
    
    constructor(address _proofStorage) Ownable(msg.sender) {
        require(_proofStorage != address(0), "Invalid proof storage address");
        proofStorage = zkTLSProofStorage(_proofStorage);
        signalMarketSet = false;
    }
    
    function setSignalMarket(address _signalMarket) external onlyOwner {
        require(_signalMarket != address(0), "Invalid address");
        require(!signalMarketSet, "SignalMarket already set");
        signalMarketContract = _signalMarket;
        signalMarketSet = true;
    }
    
    function registerAgent(string calldata name) external {
        require(!isRegistered[msg.sender], "Agent already registered");
        require(bytes(name).length > 0, "Name cannot be empty");
        
        agents[msg.sender] = Agent({
            name: name,
            walletAddress: msg.sender,
            latestProofId: bytes32(0),
            reputationScore: 0,
            totalRatings: 0,
            active: true,
            registeredAt: block.timestamp
        });
        
        isRegistered[msg.sender] = true;
        
        emit AgentRegistered(msg.sender, name);
    }
    
    function updateAttestation(bytes32 newProofId) external onlyRegistered {
        require(newProofId != bytes32(0), "Invalid proofId");
        require(proofStorage.proofExists(newProofId), "Proof not found");
        
        zkTLSProofStorage.StoredProof memory storedProof = proofStorage.getProof(newProofId);
        require(storedProof.provider == msg.sender, "Proof does not belong to caller");
        
        agents[msg.sender].latestProofId = newProofId;
        
        emit AttestationUpdated(msg.sender, newProofId);
    }
    
    function updateReputation(address agentAddr, uint8 score) external onlySignalMarket {
        require(score >= 1 && score <= 5, "Score must be between 1 and 5");
        require(isRegistered[agentAddr], "Agent not registered");
        
        Agent storage agent = agents[agentAddr];
        
        if (agent.totalRatings == 0) {
            agent.reputationScore = uint256(score) * 100;
        } else {
            agent.reputationScore = (agent.reputationScore * 4 + uint256(score) * 100) / 5;
        }
        
        agent.totalRatings += 1;
        
        emit ReputationUpdated(agentAddr, score, agent.reputationScore);
    }
    
    function getAgent(address walletAddress) external view returns (Agent memory) {
        require(isRegistered[walletAddress], "Agent not registered");
        return agents[walletAddress];
    }
    
    function getReputation(address walletAddress) external view returns (
        uint256 reputationScore,
        uint256 totalRatings
    ) {
        require(isRegistered[walletAddress], "Agent not registered");
        Agent memory agent = agents[walletAddress];
        return (agent.reputationScore, agent.totalRatings);
    }
    
    function deactivate() external onlyRegistered {
        agents[msg.sender].active = false;
    }
    
    function reactivate() external onlyRegistered {
        agents[msg.sender].active = true;
    }
}
