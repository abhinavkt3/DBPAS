// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IERC721Receiver {
    function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external returns (bytes4);
}

/// @title DBPASProduct
/// @notice Revised-paper Solidity reference contract for the DBPAS lifecycle.
/// @dev This contract keeps nonce updates and ownership transfer atomic so the
///      checkpoint invariant from the revised paper cannot be bypassed.
contract DBPASProduct {
    struct ProductAsset {
        string productId;
        bytes32 currentNonce;
        bytes32 gpsDestHash;
        uint64 minTransitTime;
        bool consumed;
        address owner;
        uint16 transferCount;
    }

    string public constant name = "DBPAS Product";
    string public constant symbol = "DBPAS";

    uint8 public constant AUTHENTIC = 0;
    uint8 public constant CLONE_ALERT = 1;
    uint8 public constant TAMPERED = 2;

    uint256 private _nextId;

    mapping(uint256 => ProductAsset) private _assets;
    mapping(uint256 => address[]) private _ownerHistory;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event ProductRegistered(
        uint256 indexed tokenId,
        string productId,
        address indexed manufacturer,
        bytes32 initialNonce
    );
    event CloneAlert(uint256 indexed tokenId, address indexed scanner);
    event CheckpointAtomic(
        uint256 indexed tokenId,
        address indexed from,
        address indexed to,
        bytes32 newNonce
    );

    modifier onlyExisting(uint256 tokenId) {
        require(_exists(tokenId), "Unknown token");
        _;
    }

    function balanceOf(address owner) external view returns (uint256) {
        require(owner != address(0), "Zero address");
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) public view onlyExisting(tokenId) returns (address) {
        return _assets[tokenId].owner;
    }

    function getApproved(uint256 tokenId) external view onlyExisting(tokenId) returns (address) {
        return _tokenApprovals[tokenId];
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function approve(address to, uint256 tokenId) external onlyExisting(tokenId) {
        address owner = ownerOf(tokenId);
        require(
            msg.sender == owner || _operatorApprovals[owner][msg.sender],
            "Not owner nor operator"
        );
        _tokenApprovals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        require(operator != msg.sender, "Self approval");
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    /// @notice Mint a new lifecycle asset at the manufacturing checkpoint.
    function registerProduct(
        string calldata pid,
        bytes32 initialNonce,
        bytes32 gpsDestHash,
        uint64 minTransitTime
    ) external returns (uint256 tokenId) {
        require(bytes(pid).length > 0, "Empty productId");
        require(initialNonce != bytes32(0), "Empty nonce");
        require(gpsDestHash != bytes32(0), "Empty gps hash");

        tokenId = ++_nextId;

        _assets[tokenId] = ProductAsset({
            productId: pid,
            currentNonce: initialNonce,
            gpsDestHash: gpsDestHash,
            minTransitTime: minTransitTime,
            consumed: false,
            owner: msg.sender,
            transferCount: 0
        });

        _balances[msg.sender] += 1;
        _ownerHistory[tokenId].push(msg.sender);

        emit Transfer(address(0), msg.sender, tokenId);
        emit ProductRegistered(tokenId, pid, msg.sender, initialNonce);
    }

    /// @notice Atomically advance nonce state and custody in one checkpoint event.
    function atomicCheckpoint(
        uint256 tokenId,
        address newOwner,
        bytes32 newNonce,
        bytes32 newGpsDestHash,
        uint64 newMinTransit
    ) external onlyExisting(tokenId) {
        ProductAsset storage asset = _assets[tokenId];
        address previousOwner = asset.owner;

        require(_isApprovedOrOwner(msg.sender, tokenId), "Not owner nor approved");
        require(newOwner != address(0), "Zero owner");
        require(newOwner != previousOwner, "Same owner");
        require(newNonce != bytes32(0), "Empty nonce");
        require(newGpsDestHash != bytes32(0), "Empty gps hash");

        _clearApproval(tokenId);
        _balances[previousOwner] -= 1;
        _balances[newOwner] += 1;

        asset.currentNonce = newNonce;
        asset.gpsDestHash = newGpsDestHash;
        asset.minTransitTime = newMinTransit;
        asset.consumed = false;
        asset.owner = newOwner;
        asset.transferCount += 1;
        _ownerHistory[tokenId].push(newOwner);

        emit Transfer(previousOwner, newOwner, tokenId);
        emit CheckpointAtomic(tokenId, previousOwner, newOwner, newNonce);

        require(
            _checkOnERC721Received(previousOwner, newOwner, tokenId, ""),
            "Unsafe receiver"
        );
    }

    /// @notice Verify the GNQR nonce presented by the scanner.
    /// @return result 0 = AUTHENTIC, 1 = CLONE_ALERT, 2 = TAMPERED
    function verifyProduct(
        uint256 tokenId,
        bytes32 claimedNonce
    ) external onlyExisting(tokenId) returns (uint8 result) {
        ProductAsset storage asset = _assets[tokenId];

        if (asset.consumed) {
            emit CloneAlert(tokenId, msg.sender);
            return CLONE_ALERT;
        }

        if (asset.currentNonce != claimedNonce) {
            return TAMPERED;
        }

        asset.consumed = true;
        return AUTHENTIC;
    }

    function getProductAsset(
        uint256 tokenId
    ) external view onlyExisting(tokenId) returns (ProductAsset memory) {
        return _assets[tokenId];
    }

    function getOwnerHistory(
        uint256 tokenId
    ) external view onlyExisting(tokenId) returns (address[] memory) {
        return _ownerHistory[tokenId];
    }

    /// @dev Public ERC-721 transfer methods are intentionally disabled because
    ///      raw ownership moves would violate the nonce-ownership atomicity invariant.
    function transferFrom(address, address, uint256) external pure {
        revert("Use atomicCheckpoint");
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert("Use atomicCheckpoint");
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert("Use atomicCheckpoint");
    }

    function _exists(uint256 tokenId) internal view returns (bool) {
        return _assets[tokenId].owner != address(0);
    }

    function _isApprovedOrOwner(address operator, uint256 tokenId) internal view returns (bool) {
        address owner = _assets[tokenId].owner;
        return (
            operator == owner ||
            _tokenApprovals[tokenId] == operator ||
            _operatorApprovals[owner][operator]
        );
    }

    function _clearApproval(uint256 tokenId) internal {
        if (_tokenApprovals[tokenId] != address(0)) {
            delete _tokenApprovals[tokenId];
        }
    }

    function _checkOnERC721Received(
        address from,
        address to,
        uint256 tokenId,
        bytes memory data
    ) internal returns (bool) {
        if (to.code.length == 0) {
            return true;
        }

        try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (
            bytes4 retval
        ) {
            return retval == IERC721Receiver.onERC721Received.selector;
        } catch {
            return false;
        }
    }
}
