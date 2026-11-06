// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ZeroDropStorage
/// @notice Decentralized Storage Endowment for Large-Scale Disclosures (Panama Papers scale).
/// @dev Enables whistleblowers, journalists, and media organizations to fund long-term
///      decentralized persistence on IPFS/Filecoin for massive datasets (audio, video, DB dumps,
///      and multi-gigabyte archives) beyond the default 1 MiB free tier.
///
///      Features:
///      1. Free tier for small disclosures (<= 1 MiB sponsored by community float).
///      2. Storage Endowment: Anyone can deposit ETH to sponsor storage for a specific CID digest.
///      3. Crowdfunded "Keep-Online": Readers and newsrooms can top up endowments to preserve leaks forever.
///      4. Pinner Incentives: Independent pinner nodes register and claim streaming storage rewards.
contract ZeroDropStorage {
    /// @notice 1 MiB free tier (1,048,576 bytes). Disclosures under this size incur 0 storage fees.
    uint256 public constant FREE_TIER_BYTES = 1048576;

    /// @notice Storage rate: wei per MB per block.
    /// @dev Defaults to 100 gwei per MB per 100,000 blocks (~2 weeks on Ethereum).
    uint256 public ratePerMbPerBlock;

    address public owner;

    struct StorageEndowment {
        uint256 balance;         // Remaining reward pool for pinners (wei)
        uint256 sizeBytes;       // Dataset size in bytes (e.g., 50 GB)
        uint256 paidUntilBlock;  // Block height until which persistence is guaranteed
        uint256 lastClaimBlock;  // Last block at which pinner rewards were claimed
        uint256 totalFunded;     // Lifetime funding received by this disclosure
        address primarySponsor;  // First funder (e.g. poster or sponsor)
        bool exists;
    }

    struct PinnerRegistration {
        address pinnerAddress;
        string multiaddr;
        uint256 registeredAtBlock;
        bool active;
    }

    /// @notice CID digest => Storage Endowment
    mapping(bytes32 => StorageEndowment) public endowments;

    /// @notice CID digest => Registered Pinners
    mapping(bytes32 => PinnerRegistration[]) internal _pinners;

    /// @notice Tracks if an address is already registered as a pinner for a CID
    mapping(bytes32 => mapping(address => bool)) public isPinner;

    event StorageFunded(
        bytes32 indexed cidDigest,
        address indexed sponsor,
        uint256 amount,
        uint256 sizeBytes,
        uint256 paidUntilBlock
    );

    event StorageToppedUp(
        bytes32 indexed cidDigest,
        address indexed contributor,
        uint256 amount,
        uint256 newPaidUntilBlock
    );

    event PinnerRegistered(
        bytes32 indexed cidDigest,
        address indexed pinner,
        string multiaddr
    );

    event PinnerRewardClaimed(
        bytes32 indexed cidDigest,
        address indexed pinner,
        uint256 rewardAmount
    );

    error InvalidSize();
    error ZeroDeposit();
    error NotFunded();
    error AlreadyRegistered();
    error NotRegisteredPinner();
    error NoRewardsAvailable();
    error Unauthorized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor() {
        owner = msg.sender;
        // 100 wei per MB per block baseline
        ratePerMbPerBlock = 100;
    }

    function setRatePerMbPerBlock(uint256 newRate) external onlyOwner {
        ratePerMbPerBlock = newRate;
    }

    /// @notice Quotes the storage endowment cost for a given size and duration.
    /// @param sizeBytes Total dataset size in bytes.
    /// @param durationBlocks Target number of blocks to preserve.
    /// @return costWei Required deposit in wei (0 for <= 1 MiB).
    function quoteStorageCost(uint256 sizeBytes, uint256 durationBlocks) public view returns (uint256 costWei) {
        if (sizeBytes <= FREE_TIER_BYTES) {
            return 0;
        }
        uint256 excessBytes = sizeBytes - FREE_TIER_BYTES;
        uint256 excessMb = (excessBytes + 1048575) / 1048576; // Round up to nearest MB
        costWei = excessMb * ratePerMbPerBlock * durationBlocks;
    }

    /// @notice Funds the initial storage endowment for a large-scale disclosure.
    /// @param cidDigest 32-byte sha256 digest of the raw/DAG CID.
    /// @param sizeBytes Total size in bytes of the leaked dataset.
    function fundStorage(bytes32 cidDigest, uint256 sizeBytes) external payable {
        if (sizeBytes == 0) revert InvalidSize();
        if (msg.value == 0 && sizeBytes > FREE_TIER_BYTES) revert ZeroDeposit();

        StorageEndowment storage end = endowments[cidDigest];
        uint256 excessBytes = sizeBytes > FREE_TIER_BYTES ? sizeBytes - FREE_TIER_BYTES : 0;
        uint256 excessMb = (excessBytes + 1048575) / 1048576;

        uint256 blocksFunded = excessMb == 0 ? 1000000 : (msg.value / (excessMb * ratePerMbPerBlock));
        uint256 startBlock = block.number > end.paidUntilBlock ? block.number : end.paidUntilBlock;
        uint256 targetPaidUntil = startBlock + blocksFunded;

        if (!end.exists) {
            endowments[cidDigest] = StorageEndowment({
                balance: msg.value,
                sizeBytes: sizeBytes,
                paidUntilBlock: targetPaidUntil,
                lastClaimBlock: block.number,
                totalFunded: msg.value,
                primarySponsor: msg.sender,
                exists: true
            });
        } else {
            end.balance += msg.value;
            end.totalFunded += msg.value;
            if (sizeBytes > end.sizeBytes) {
                end.sizeBytes = sizeBytes;
            }
            end.paidUntilBlock = targetPaidUntil;
        }

        emit StorageFunded(cidDigest, msg.sender, msg.value, sizeBytes, targetPaidUntil);
    }

    /// @notice Crowdfund storage for an endangered or high-value disclosure.
    /// @param cidDigest 32-byte sha256 digest of the disclosure.
    function topUpStorage(bytes32 cidDigest) external payable {
        if (msg.value == 0) revert ZeroDeposit();
        StorageEndowment storage end = endowments[cidDigest];
        if (!end.exists) revert NotFunded();

        uint256 excessBytes = end.sizeBytes > FREE_TIER_BYTES ? end.sizeBytes - FREE_TIER_BYTES : 0;
        uint256 excessMb = (excessBytes + 1048575) / 1048576;
        uint256 additionalBlocks = excessMb == 0 ? 1000000 : (msg.value / (excessMb * ratePerMbPerBlock));

        uint256 baseBlock = block.number > end.paidUntilBlock ? block.number : end.paidUntilBlock;
        end.paidUntilBlock = baseBlock + additionalBlocks;
        end.balance += msg.value;
        end.totalFunded += msg.value;

        emit StorageToppedUp(cidDigest, msg.sender, msg.value, end.paidUntilBlock);
    }

    /// @notice Registers an independent pinner node to replicate and pin this dataset.
    /// @param cidDigest 32-byte sha256 digest of the disclosure.
    /// @param multiaddr IPFS / Libp2p multiaddr of the pinning node.
    function registerPinner(bytes32 cidDigest, string calldata multiaddr) external {
        if (!endowments[cidDigest].exists) revert NotFunded();
        if (isPinner[cidDigest][msg.sender]) revert AlreadyRegistered();

        isPinner[cidDigest][msg.sender] = true;
        _pinners[cidDigest].push(PinnerRegistration({
            pinnerAddress: msg.sender,
            multiaddr: multiaddr,
            registeredAtBlock: block.number,
            active: true
        }));

        emit PinnerRegistered(cidDigest, msg.sender, multiaddr);
    }

    /// @notice Claims accrued streaming storage rewards for participating pinners.
    /// @param cidDigest 32-byte sha256 digest of the disclosure.
    function claimStorageRewards(bytes32 cidDigest) external {
        if (!isPinner[cidDigest][msg.sender]) revert NotRegisteredPinner();
        StorageEndowment storage end = endowments[cidDigest];

        uint256 currentBlock = block.number > end.paidUntilBlock ? end.paidUntilBlock : block.number;
        if (currentBlock <= end.lastClaimBlock) revert NoRewardsAvailable();

        uint256 blocksElapsed = currentBlock - end.lastClaimBlock;
        uint256 excessBytes = end.sizeBytes > FREE_TIER_BYTES ? end.sizeBytes - FREE_TIER_BYTES : 0;
        uint256 excessMb = (excessBytes + 1048575) / 1048576;
        uint256 totalAccrued = excessMb * ratePerMbPerBlock * blocksElapsed;

        if (totalAccrued > end.balance) {
            totalAccrued = end.balance;
        }

        uint256 pinnerCount = _pinners[cidDigest].length;
        if (pinnerCount == 0 || totalAccrued == 0) revert NoRewardsAvailable();

        uint256 rewardPerPinner = totalAccrued / pinnerCount;
        end.balance -= totalAccrued;
        end.lastClaimBlock = currentBlock;

        (bool success, ) = payable(msg.sender).call{value: rewardPerPinner}("");
        require(success, "Reward transfer failed");

        emit PinnerRewardClaimed(cidDigest, msg.sender, rewardPerPinner);
    }

    /// @notice Returns full storage status and remaining persistence runway.
    function getStorageStatus(bytes32 cidDigest)
        external
        view
        returns (
            bool isFunded,
            uint256 balance,
            uint256 sizeBytes,
            uint256 paidUntilBlock,
            uint256 blocksRemaining,
            uint256 pinnerCount
        )
    {
        StorageEndowment memory end = endowments[cidDigest];
        if (!end.exists) {
            return (false, 0, 0, 0, 0, 0);
        }

        uint256 remaining = end.paidUntilBlock > block.number ? end.paidUntilBlock - block.number : 0;
        return (
            true,
            end.balance,
            end.sizeBytes,
            end.paidUntilBlock,
            remaining,
            _pinners[cidDigest].length
        );
    }
}

