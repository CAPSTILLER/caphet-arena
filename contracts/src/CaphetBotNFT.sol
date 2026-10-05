// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CaphetBotNFT
/// @notice 1,000 CAPHET Arena bot NFTs for humans first (distribution). Each mint costs 100 GEAR
///         (90% treasury, 10% GearVault). One mint per wallet. Rarity is fixed at mint and caps the
///         daily CAPH payout forever (common 10, uncommon 20, rare 50, mythic 100). This contract
///         never pays CAPH and never grants agent keys, strategy code, or playable-seat auth.
///
///         Security model (Cap locked)
///           An NFT bot is a holding certificate, not a stealable real agent. Daily "play" is a
///           later server-attested claim that checks ownerOf(tokenId) onchain and pays only the
///           rarity table amount. There is no private key, no agent API, and no downloadable bot
///           strategy attached to the NFT. House/demo bots stay separate. Real agent play is a
///           later phase with different auth.
///
///         Randomness (choice and tradeoffs)
///           Minting stays paused until the owner reveals a previously committed seed
///           (commit-reveal). After reveal, each mint assigns rarity from
///           keccak256(seed, tokenId, minter, block.prevrandao, block.timestamp) with weights
///           50/30/15/5. Why this mix:
///             - Commit-reveal stops Cap from picking a seed after seeing who mints.
///             - Including prevrandao/timestamp at mint time stops offline grinding of
///               wallets against a public seed alone.
///             - Base still has a centralized sequencer that can bias prevrandao slightly;
///               Cap accepts that tradeoff instead of Chainlink VRF for this mint.
///           Odds are checked in the Foundry tests against the weight table.
///
///         GEAR decimals: the mint price is 100 * 10^decimals() of the GEAR token (read on
///         deploy). Cap must pass the real GEAR ERC-20 on Base Sepolia / Base.

interface IERC20MintPay {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

contract CaphetBotNFT {
    // ---------------------------------------------------------------------
    // errors and events
    // ---------------------------------------------------------------------

    error NotOwner();
    error NotPendingOwner();
    error PausedError();
    error ZeroAddress();
    error SoldOut();
    error AlreadyMinted();
    error SeedAlreadyCommitted();
    error SeedNotCommitted();
    error SeedAlreadyRevealed();
    error BadSeedReveal();
    error SeedNotRevealed();
    error NotTokenOwner();
    error NotApproved();
    error BadToken();
    error TransferToZero();
    error EthRejected();
    error GearTransferFailed();

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed spender, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Minted(address indexed to, uint256 indexed tokenId, uint8 indexed rarity);
    event SeedCommitted(bytes32 commit);
    event SeedRevealed(bytes32 seed);
    event MintOpened();
    event TreasurySet(address indexed treasury);
    event GearVaultSet(address indexed gearVault);
    event BaseURISet(string baseURI);
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    // ---------------------------------------------------------------------
    // constants (Cap locked product rules)
    // ---------------------------------------------------------------------

    uint256 public constant MAX_SUPPLY = 1000;
    uint256 public constant MINT_GEAR_WHOLE = 100; // 100 GEAR whole tokens (scaled by GEAR decimals)
    uint256 public constant TREASURY_BPS = 9000; // 90%
    uint256 public constant VAULT_BPS = 1000; // 10%
    uint256 public constant BPS = 10_000;

    uint8 public constant RARITY_COMMON = 0;
    uint8 public constant RARITY_UNCOMMON = 1;
    uint8 public constant RARITY_RARE = 2;
    uint8 public constant RARITY_MYTHIC = 3;

    /// @dev Weight bands out of 100 for common / uncommon / rare / mythic.
    uint8 public constant WEIGHT_COMMON = 50;
    uint8 public constant WEIGHT_UNCOMMON = 30;
    uint8 public constant WEIGHT_RARE = 15;
    uint8 public constant WEIGHT_MYTHIC = 5;

    /// @dev Fixed daily CAPH payout by rarity. HARD CAP for NFT bots: never more than this per day.
    uint256 public constant PAYOUT_COMMON = 10;
    uint256 public constant PAYOUT_UNCOMMON = 20;
    uint256 public constant PAYOUT_RARE = 50;
    uint256 public constant PAYOUT_MYTHIC = 100;

    /// @dev Vault safety limits for the later claim system (documented here; not enforced in this NFT).
    uint256 public constant VAULT_DAY_LIMIT_CAPH = 500_000;
    uint256 public constant VAULT_PER_PAYOUT_LIMIT_CAPH = 10_000;

    string public constant NAME = "CAPHET Arena Bot";
    string public constant SYMBOL = "CAPHBOT";

    // ---------------------------------------------------------------------
    // storage
    // ---------------------------------------------------------------------

    IERC20MintPay public immutable gear;
    uint256 public immutable mintPrice; // 100 * 10^gear.decimals()

    address public owner;
    address public pendingOwner;
    address public treasury;
    address public gearVault;
    bool public paused;

    bytes32 public seedCommit;
    bytes32 public seed;
    bool public seedRevealed;
    bool public mintOpened;

    uint256 public totalSupply;
    string private _baseURI;

    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(uint256 => address) private _tokenApproval;
    mapping(address => mapping(address => bool)) private _operatorApproval;
    mapping(address => bool) public hasMinted;
    mapping(uint256 => uint8) private _rarityOf; // tokenId => rarity (0..3)

    // ---------------------------------------------------------------------
    // constructor
    // ---------------------------------------------------------------------

    /// @param initialOwner Cap admin (Safe preferred). Sets treasury, vault, seed, pause, URI.
    /// @param gearToken GEAR ERC-20 Cap provides.
    /// @param treasury_ Address that receives 90% of each mint's GEAR.
    /// @param gearVault_ Address that receives 10% of each mint's GEAR (GearVault).
    /// @param baseURI_ Metadata prefix; tokenURI is baseURI + tokenId + ".json".
    constructor(address initialOwner, address gearToken, address treasury_, address gearVault_, string memory baseURI_) {
        if (initialOwner == address(0) || gearToken == address(0) || treasury_ == address(0) || gearVault_ == address(0)) {
            revert ZeroAddress();
        }
        owner = initialOwner;
        gear = IERC20MintPay(gearToken);
        treasury = treasury_;
        gearVault = gearVault_;
        _baseURI = baseURI_;
        uint8 d = IERC20MintPay(gearToken).decimals();
        mintPrice = MINT_GEAR_WHOLE * (10 ** uint256(d));
        emit TreasurySet(treasury_);
        emit GearVaultSet(gearVault_);
        emit BaseURISet(baseURI_);
        emit OwnershipTransferred(address(0), initialOwner);
    }

    // ---------------------------------------------------------------------
    // ERC-721 views
    // ---------------------------------------------------------------------

    function name() external pure returns (string memory) { return NAME; }
    function symbol() external pure returns (string memory) { return SYMBOL; }

    function balanceOf(address account) external view returns (uint256) {
        if (account == address(0)) revert ZeroAddress();
        return _balanceOf[account];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address o = _ownerOf[tokenId];
        if (o == address(0)) revert BadToken();
        return o;
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        if (_ownerOf[tokenId] == address(0)) revert BadToken();
        return _tokenApproval[tokenId];
    }

    function isApprovedForAll(address account, address operator) external view returns (bool) {
        return _operatorApproval[account][operator];
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_ownerOf[tokenId] == address(0)) revert BadToken();
        return string(abi.encodePacked(_baseURI, _toString(tokenId), ".json"));
    }

    function baseURI() external view returns (string memory) { return _baseURI; }

    function rarityOf(uint256 tokenId) public view returns (uint8) {
        if (_ownerOf[tokenId] == address(0)) revert BadToken();
        return _rarityOf[tokenId];
    }

    /// @notice Fixed daily CAPH payout for this token's rarity. HARD CAP for NFT bots.
    function dailyPayoutOf(uint256 tokenId) external view returns (uint256) {
        return payoutForRarity(rarityOf(tokenId));
    }

    function payoutForRarity(uint8 rarity) public pure returns (uint256) {
        if (rarity == RARITY_COMMON) return PAYOUT_COMMON;
        if (rarity == RARITY_UNCOMMON) return PAYOUT_UNCOMMON;
        if (rarity == RARITY_RARE) return PAYOUT_RARE;
        if (rarity == RARITY_MYTHIC) return PAYOUT_MYTHIC;
        revert BadToken();
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        // ERC165 + ERC721 + ERC721Metadata
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd || interfaceId == 0x5b5e139f;
    }

    // ---------------------------------------------------------------------
    // mint seed (commit-reveal) and mint
    // ---------------------------------------------------------------------

    /// @notice Owner publishes keccak256(abi.encodePacked(seed)) before minting can open.
    function commitMintSeed(bytes32 commit) external onlyOwner {
        if (commit == bytes32(0)) revert BadSeedReveal();
        if (seedCommit != bytes32(0)) revert SeedAlreadyCommitted();
        seedCommit = commit;
        emit SeedCommitted(commit);
    }

    /// @notice Owner reveals the seed. Must match the commit. Does not open minting by itself.
    function revealMintSeed(bytes32 seed_) external onlyOwner {
        if (seedCommit == bytes32(0)) revert SeedNotCommitted();
        if (seedRevealed) revert SeedAlreadyRevealed();
        if (keccak256(abi.encodePacked(seed_)) != seedCommit) revert BadSeedReveal();
        seed = seed_;
        seedRevealed = true;
        emit SeedRevealed(seed_);
    }

    /// @notice Owner opens minting after the seed is revealed.
    function openMint() external onlyOwner {
        if (!seedRevealed) revert SeedNotRevealed();
        mintOpened = true;
        emit MintOpened();
    }

    /// @notice Mint one bot NFT. Pulls 100 GEAR from the caller (approve first), sends 90% to
    ///         treasury and 10% to GearVault. One mint per wallet. Rarity assigned immediately.
    function mint() external whenNotPaused returns (uint256 tokenId) {
        if (!mintOpened) revert SeedNotRevealed();
        if (totalSupply >= MAX_SUPPLY) revert SoldOut();
        if (hasMinted[msg.sender]) revert AlreadyMinted();

        uint256 price = mintPrice;
        uint256 toTreasury = (price * TREASURY_BPS) / BPS;
        uint256 toVault = price - toTreasury; // remainder so dust stays exact

        if (!gear.transferFrom(msg.sender, treasury, toTreasury)) revert GearTransferFailed();
        if (!gear.transferFrom(msg.sender, gearVault, toVault)) revert GearTransferFailed();

        tokenId = totalSupply + 1; // token ids 1..1000
        uint8 rarity = _rollRarity(tokenId, msg.sender);

        hasMinted[msg.sender] = true;
        totalSupply = tokenId;
        _rarityOf[tokenId] = rarity;
        _mint(msg.sender, tokenId);
        emit Minted(msg.sender, tokenId, rarity);
    }

    function _rollRarity(uint256 tokenId, address minter) internal view returns (uint8) {
        uint256 roll = uint256(keccak256(abi.encodePacked(seed, tokenId, minter, block.prevrandao, block.timestamp))) % 100;
        if (roll < WEIGHT_COMMON) return RARITY_COMMON; // 0..49
        if (roll < WEIGHT_COMMON + WEIGHT_UNCOMMON) return RARITY_UNCOMMON; // 50..79
        if (roll < WEIGHT_COMMON + WEIGHT_UNCOMMON + WEIGHT_RARE) return RARITY_RARE; // 80..94
        return RARITY_MYTHIC; // 95..99
    }

    /// @dev Pure helper for tests and UIs: map a 0..99 roll onto the rarity table.
    function rarityFromRoll(uint256 rollMod100) external pure returns (uint8) {
        uint256 roll = rollMod100 % 100;
        if (roll < WEIGHT_COMMON) return RARITY_COMMON;
        if (roll < WEIGHT_COMMON + WEIGHT_UNCOMMON) return RARITY_UNCOMMON;
        if (roll < WEIGHT_COMMON + WEIGHT_UNCOMMON + WEIGHT_RARE) return RARITY_RARE;
        return RARITY_MYTHIC;
    }

    // ---------------------------------------------------------------------
    // ERC-721 transfers
    // ---------------------------------------------------------------------

    function approve(address spender, uint256 tokenId) external {
        address o = ownerOf(tokenId);
        if (msg.sender != o && !_operatorApproval[o][msg.sender]) revert NotApproved();
        _tokenApproval[tokenId] = spender;
        emit Approval(o, spender, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApproval[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public whenNotPaused {
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external whenNotPaused {
        _transfer(from, to, tokenId);
        _checkOnERC721Received(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external whenNotPaused {
        _transfer(from, to, tokenId);
        _checkOnERC721Received(from, to, tokenId, data);
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        if (to == address(0)) revert TransferToZero();
        address o = ownerOf(tokenId);
        if (o != from) revert NotTokenOwner();
        if (msg.sender != from && msg.sender != _tokenApproval[tokenId] && !_operatorApproval[from][msg.sender]) {
            revert NotApproved();
        }
        _tokenApproval[tokenId] = address(0);
        _balanceOf[from] -= 1;
        _balanceOf[to] += 1;
        _ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
        emit Approval(from, address(0), tokenId);
    }

    function _mint(address to, uint256 tokenId) internal {
        _balanceOf[to] += 1;
        _ownerOf[tokenId] = to;
        emit Transfer(address(0), to, tokenId);
    }

    function _checkOnERC721Received(address from, address to, uint256 tokenId, bytes memory data) internal {
        if (to.code.length == 0) return;
        // solhint-disable-next-line avoid-low-level-calls
        (bool ok, bytes memory ret) = to.call(abi.encodeWithSelector(0x150b7a02, msg.sender, from, tokenId, data));
        if (!ok || ret.length != 32 || abi.decode(ret, (bytes4)) != bytes4(0x150b7a02)) revert TransferToZero();
    }

    // ---------------------------------------------------------------------
    // admin
    // ---------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedError();
        _;
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function setGearVault(address gearVault_) external onlyOwner {
        if (gearVault_ == address(0)) revert ZeroAddress();
        gearVault = gearVault_;
        emit GearVaultSet(gearVault_);
    }

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        _baseURI = baseURI_;
        emit BaseURISet(baseURI_);
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address prev = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(prev, msg.sender);
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 temp = v;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buf = new bytes(digits);
        while (v != 0) { digits -= 1; buf[digits] = bytes1(uint8(48 + (v % 10))); v /= 10; }
        return string(buf);
    }
}
