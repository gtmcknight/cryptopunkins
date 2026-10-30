// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "solady/tokens/ERC721.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";
import {Renderer} from "./Renderer.sol";

/// @notice CryptoPunkins, a 2026 game on the 2021 art: 1,031 pumpkins, all for sale.
/// Buy a whole pumpkin; 90% of the price goes in the pot and 10% to `payout`. It comes with two knives, which break if
/// their own pumpkin is carved first. Carving anyone else's opens at 8 PM on Halloween, the moment sales close, so
/// everyone starts the night together whenever they bought; your own you can carve any time, to see its face. A carve
/// takes its face from the hash of the block it lands in, which nobody knows when they send it. Any pumpkin still
/// whole at midnight becomes a Great Pumpkin, forever, and the Great Pumpkins split the pot (if none are, every
/// pumpkin sold gets an equal share back): anyone can send every share out, and any not sent can be claimed.
/// An uncut pumpkin's colour is set by its id (see the renderer).
/// No owner powers: nothing to mint for free, no price to change, no art to swap, no way into the pot.
contract CryptoPunkins is ERC721, ReentrancyGuardTransient {
    uint256 public constant PRICE = 0.00666 ether;
    /// @notice The part of each sale that goes to `payout` instead of the pot.
    uint256 public constant CUT = PRICE / 10;
    /// @notice The most one buy can take. No limit per wallet.
    uint256 public constant PER_BUY = 10;
    uint256 public constant FOR_SALE = 1031;
    /// @notice Sales close and carving opens this long before midnight: 8 PM on Halloween in New York.
    uint256 public constant LAST_CALL = 4 hours;
    /// EIP-2935: the last 8,191 block hashes, for a carve nobody settled within 256 blocks
    address internal constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;
    uint8 public constant KNIVES = 2;
    /// carves a buy or a carve finishes on its way through, so nobody waits on a quiet patch for long
    uint256 internal constant SETTLE_PER_CALL = 4;
    /// pending carves a view will play forward to show a face before it's settled
    uint256 internal constant SIMULATE = 48;
    /// the most gas one share's send may use (as Credit Union's refunds): plenty for any wallet, and a wallet that
    /// refuses ETH or burns gas can't block the rest
    uint256 internal constant SEND_GAS = 50_000;

    uint8 internal constant WHOLE = 0;
    uint8 internal constant CARVING = 1;
    uint8 internal constant CARVED = 2;

    Renderer public immutable renderer;
    /// @notice Carving closes here and the whole pumpkins turn Great: midnight on Halloween, New York time.
    uint256 public immutable end;
    /// @notice Sales close and carving opens here, `LAST_CALL` before `end`.
    uint256 public immutable salesEnd;
    /// @notice Where the cut goes. Anyone can send it there.
    address public immutable payout;
    address internal immutable _owner;

    struct Pumpkin {
        uint16 edition; // the 2021 number, once carved
        uint8 state;
        uint8 used; // knives used (so a new pumpkin costs no extra write)
        bool broken; // it was carved with knives left, and they broke
        uint16 cut1; // what its knives carved, in order
        uint16 cut2;
        uint64 carveBlock; // the face comes from this block's hash, readable from the next block on
    }

    mapping(uint256 => Pumpkin) internal _p;
    mapping(uint256 => address) public carverOf;
    /// @notice What each Great Pumpkin has been paid from the pot so far.
    mapping(uint256 => uint256) public paidOut;
    /// Fisher-Yates over the 1,031 faces: slot => value + 1 once moved
    mapping(uint256 => uint256) internal _moved;
    uint256 public sold;
    uint256 public carved;
    /// @notice Pumpkins still whole. From midnight on Halloween these are the Great Pumpkins.
    uint256 public whole;
    uint256 internal _cutSent;
    /// @notice ETH added to the pot from outside, such as a coin's trading fees.
    uint256 public fed;
    uint256[] internal _queue;
    uint256 public head;
    bool internal _toldGreat;
    bool internal _toldLit;

    event Bought(address indexed buyer, uint256 firstId, uint256 count);
    event Carving(uint256 indexed id, uint256 indexed knife, address indexed carver);
    event Carved(uint256 indexed id, uint256 edition);
    event Claimed(uint256 indexed id, address indexed owner, uint256 amount);
    event Fed(address indexed from, uint256 amount);
    /// ERC-4906, so marketplaces redraw a pumpkin when it's carved and every Great Pumpkin after midnight
    event MetadataUpdate(uint256 _tokenId);
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    error Closed();
    error TooMany();
    error SoldOut();
    error WrongPrice();
    error NotYourKnife();
    error KnifeUsed();
    error KnifeBroken();
    error NotCarvingYet();
    error NotWhole();
    error TooEarly();
    error NotYours();
    error AlreadyPaid();
    error NoShare();

    constructor(
        Renderer renderer_,
        uint256 end_,
        address payout_,
        address owner_
    ) {
        renderer = renderer_;
        end = end_;
        salesEnd = end_ - LAST_CALL;
        payout = payout_;
        _owner = owner_;
    }

    function supportsInterface(bytes4 id) public view override returns (bool) {
        return id == 0x49064906 || super.supportsInterface(id);
    }

    function name() public pure override returns (string memory) {
        return "CryptoPunkins";
    }

    function symbol() public pure override returns (string memory) {
        return "PUNKIN";
    }

    /// @notice For marketplace profiles only. It controls nothing here.
    function owner() external view returns (address) {
        return _owner;
    }

    // ------------------------------------------------------------------ play

    /// @notice Buy up to 10 whole pumpkins at a time, 0.00666 ETH each, 90% of it into the pot.
    function buy(uint256 count) external payable {
        if (block.timestamp >= salesEnd) revert Closed();
        if (count == 0 || count > PER_BUY) revert TooMany();
        if (sold + count > FOR_SALE) revert SoldOut();
        if (msg.value != count * PRICE) revert WrongPrice();
        uint256 first = sold + 1;
        sold += count;
        whole += count;
        for (uint256 i; i < count; ++i) _mint(msg.sender, first + i);
        emit Bought(msg.sender, first, count);
        _settle(SETTLE_PER_CALL);
    }

    /// @notice Use one of `knife`'s knives on a whole pumpkin: anyone else's from 8 PM on Halloween, your own any time
    /// (to see its face; it then can't split the pot). Its face shows up from the next block.
    function carve(uint256 knife, uint256 target) external {
        if (block.timestamp >= end) revert Closed();
        address owner_ = ownerOf(target); // (reverts for a pumpkin nobody minted: it can't be carved, or counted)
        if (block.timestamp < salesEnd && owner_ != msg.sender) revert NotCarvingYet();
        if (ownerOf(knife) != msg.sender) revert NotYourKnife();
        Pumpkin storage k = _p[knife];
        if (k.broken) revert KnifeBroken();
        if (k.used == KNIVES) revert KnifeUsed();
        if (_p[target].state != WHOLE) revert NotWhole();
        _carve(knife, target);
        _settle(SETTLE_PER_CALL);
    }

    /// @notice Several carves at once, so everyone can strike at 8 PM with one click: `knives[i]` carves `targets[i]`.
    /// Skips any pair that can't happen any more (someone carved it first, or that knife broke) instead of failing the
    /// rest, and reverts only if none could.
    function carveMany(uint256[] calldata knives, uint256[] calldata targets) external returns (uint256 done) {
        if (block.timestamp >= end) revert Closed();
        if (knives.length != targets.length) revert NotYourKnife();
        for (uint256 i; i < knives.length; ++i) {
            (uint256 knife, uint256 target) = (knives[i], targets[i]);
            if (_ownerOf(knife) != msg.sender || _ownerOf(target) == address(0)) continue;
            if (block.timestamp < salesEnd && _ownerOf(target) != msg.sender) continue;
            Pumpkin storage k = _p[knife];
            if (k.broken || k.used == KNIVES || _p[target].state != WHOLE) continue;
            _carve(knife, target);
            ++done;
        }
        if (done == 0) revert NotWhole();
        _settle(SETTLE_PER_CALL);
    }

    function _carve(uint256 knife, uint256 target) internal {
        Pumpkin storage k = _p[knife];
        Pumpkin storage t = _p[target];
        ++k.used;
        if (k.cut1 == 0) k.cut1 = uint16(target);
        else k.cut2 = uint16(target);
        t.state = CARVING;
        t.carveBlock = uint64(block.number);
        if (t.used < KNIVES) t.broken = true; // any it hadn't used break
        --whole;
        carverOf[target] = msg.sender;
        _queue.push(target);
        emit Carving(target, knife, msg.sender);
        emit MetadataUpdate(target);
        emit MetadataUpdate(knife);
    }

    /// @notice Finish carves from earlier blocks. Anyone can; buys and carves also do a few on the way.
    function settle(uint256 max) external {
        _settle(max);
    }

    /// @notice From midnight on Halloween, each Great Pumpkin's owner takes an equal share of the pot, and of anything
    /// fed to it after, whenever they like. If none survived, every pumpkin sold takes the same share instead.
    function claim(uint256[] calldata ids) external nonReentrant {
        if (block.timestamp < end) revert TooEarly();
        uint256 each = share();
        uint256 total;
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            if (ownerOf(id) != msg.sender) revert NotYours();
            if (!_shares(id)) revert NoShare();
            uint256 due = each - paidOut[id];
            paidOut[id] = each;
            total += due;
            emit Claimed(id, msg.sender, due);
            emit MetadataUpdate(id); // (its Pot share now reads Paid)
        }
        if (total == 0) revert AlreadyPaid();
        _settle(SETTLE_PER_CALL); // (finishes any carves still waiting on their face)
        SafeTransferLib.safeTransferETH(msg.sender, total);
    }

    /// @notice From midnight on Halloween, send each Great Pumpkin from `from` to `to` its share of the pot, so nobody
    /// has to come back for it. Anyone can call it, as often as they like: a pumpkin is only ever sent what it's still
    /// owed (anything fed to the pot later goes out on the next call). A wallet that refuses ETH or burns gas is skipped
    /// and stays owed, so it can still claim.
    function sendShares(uint256 from, uint256 to) external nonReentrant returns (uint256 sent) {
        if (block.timestamp < end) revert TooEarly();
        _settle(SETTLE_PER_CALL);
        uint256 each = share();
        if (to > sold) to = sold;
        for (uint256 id = from == 0 ? 1 : from; id <= to; ++id) {
            // (short of gas: stop here, the rest go on the next call; a send always gets its whole SEND_GAS)
            if (gasleft() < SEND_GAS * 2) break;
            if (!_shares(id)) continue;
            uint256 due = each - paidOut[id];
            if (due == 0) continue;
            address owner_ = _ownerOf(id);
            paidOut[id] = each;
            if (_send(owner_, due)) {
                sent += due;
                emit Claimed(id, owner_, due);
                emit MetadataUpdate(id);
            } else {
                paidOut[id] = each - due; // (refused: still owed)
            }
        }
    }

    /// A plain ETH send, gas-capped, that never copies return data.
    function _send(address to, uint256 amount) internal returns (bool ok) {
        assembly {
            ok := call(SEND_GAS, to, amount, 0, 0, 0, 0)
        }
    }

    /// @notice What these pumpkins can claim right now.
    function owed(uint256[] calldata ids) external view returns (uint256 total) {
        if (block.timestamp < end) return 0;
        uint256 each = share();
        for (uint256 i; i < ids.length; ++i) if (_shares(ids[i])) total += each - paidOut[ids[i]];
    }

    /// The Great Pumpkins split the pot; if there are none, every pumpkin sold does.
    function _shares(uint256 id) internal view returns (bool) {
        if (id == 0 || id > sold) return false; // (nobody minted it)
        return whole == 0 || _p[id].state == WHOLE;
    }

    /// For the metadata: 0 no share (or not midnight yet), 1 owed some of the pot, 2 paid all it's owed so far.
    function _potShare(uint256 id) internal view returns (uint256) {
        if (block.timestamp < end || !_shares(id)) return 0;
        return paidOut[id] == share() ? 2 : 1;
    }

    /// @notice Add to the pot. Anyone, any time: a coin's trading fees come in here. Before midnight it grows the
    /// prize; after, it's split between the Great Pumpkins as it arrives.
    function feed() public payable {
        if (block.timestamp >= end && sold == 0) revert NoShare(); // (nobody to split it: nothing ever sold)
        fed += msg.value;
        emit Fed(msg.sender, msg.value);
    }

    receive() external payable {
        feed();
    }

    /// @notice 90% of every sale, plus whatever has been fed to it.
    function pot() public view returns (uint256) {
        return sold * (PRICE - CUT) + fed;
    }

    /// @notice One Great Pumpkin's share of the pot (before midnight: if it ended now). With none whole, the share of
    /// each pumpkin sold.
    function share() public view returns (uint256) {
        if (whole != 0) return pot() / whole;
        return sold == 0 ? 0 : pot() / sold;
    }

    /// @notice Send the cut so far to `payout`. Anyone can.
    function withdraw() external {
        uint256 amount = sold * CUT - _cutSent;
        _cutSent += amount;
        SafeTransferLib.safeTransferETH(payout, amount);
    }

    // ------------------------------------------------------------------ read

    function tokenURI(uint256 id) public view override returns (string memory) {
        if (!_exists(id)) revert TokenDoesNotExist();
        Pumpkin memory p = _p[id];
        // (a face still being carved shows once it's settled, which tells marketplaces to look again: no look-ahead
        // here, so even the heaviest face fits one read call's gas)
        (uint256 look, uint256 edition) = p.state == CARVING ? (1, 0) : lookOf(id);
        return renderer.tokenURI(id, look, edition, carverOf[id], _left(p), p.broken, p.cut1, p.cut2, _potShare(id));
    }

    function contractURI() external view returns (string memory) {
        return renderer.contractURI();
    }

    /// @notice What a pumpkin shows right now: 0 whole, 1 carving, 2 carved (with its edition), 3 Great Pumpkin.
    /// A carve from an earlier block shows its face even before anyone settles it.
    function lookOf(uint256 id) public view returns (uint256 look, uint256 edition) {
        Pumpkin memory p = _p[id];
        if (p.state == CARVED) return (2, p.edition);
        if (p.state == WHOLE) return (block.timestamp >= end ? 3 : 0, 0);
        (uint256[] memory ids, uint256[] memory eds) = _playForward(id);
        for (uint256 i; i < ids.length; ++i) if (ids[i] == id) return (2, eds[i]);
        return (1, 0);
    }

    /// @notice The whole patch for the site: per token, its owner and a word
    /// look (8 bits) | edition (16) | knives left (8) | first cut (16) | carver (160) | paid up (8) | second cut (16)
    /// | broken (8).
    function patch(uint256 from, uint256 to) external view returns (address[] memory owners, uint256[] memory words) {
        uint256 last = sold;
        if (to > last) to = last;
        if (from < 1) from = 1;
        uint256 n = to >= from ? to - from + 1 : 0;
        owners = new address[](n);
        words = new uint256[](n);
        (uint256[] memory ids, uint256[] memory eds) = _playForward(0);
        for (uint256 i; i < n; ++i) {
            uint256 id = from + i;
            Pumpkin memory p = _p[id];
            uint256 look = p.state == CARVED ? 2 : p.state == WHOLE ? (block.timestamp >= end ? 3 : 0) : 1;
            uint256 edition = p.edition;
            if (p.state == CARVING) {
                for (uint256 k; k < ids.length; ++k) if (ids[k] == id) (look, edition) = (2, eds[k]);
            }
            owners[i] = _ownerOf(id);
            // (every part widened to 256 bits before its shift: a uint8 shifted by 24 is 0)
            bool paidUp = paidOut[id] != 0 && paidOut[id] == share();
            words[i] = look | edition << 8 | _left(p) << 24 | uint256(p.cut1) << 32
                | uint256(uint160(carverOf[id])) << 48 | uint256(paidUp ? 1 : 0) << 208 | uint256(p.cut2) << 216
                | uint256(p.broken ? 1 : 0) << 232;
        }
    }

    function stats()
        external
        view
        returns (
            uint256 sold_,
            uint256 carved_,
            uint256 whole_,
            uint256 pending,
            uint256 salesEnd_,
            uint256 end_,
            uint256 pot_,
            uint256 time
        )
    {
        return (sold, carved, whole, _queue.length - head, salesEnd, end, pot(), block.timestamp);
    }

    function _left(Pumpkin memory p) internal pure returns (uint256) {
        return p.broken ? 0 : KNIVES - p.used;
    }

    // ------------------------------------------------------------------ carving

    function _settle(uint256 max) internal {
        // tell marketplaces to redraw everything when the whole pumpkins turn Great (the first settle after
        // midnight) and when Halloween starts or ends (they light up every Oct 31)
        bool great = !_toldGreat && block.timestamp >= end;
        bool lit = renderer.isHalloween(block.timestamp);
        if (great || lit != _toldLit) {
            if (great) _toldGreat = true;
            _toldLit = lit;
            emit BatchMetadataUpdate(1, sold);
        }
        uint256 h = head;
        uint256 stop = _queue.length;
        uint256 done;
        while (h < stop && done < max) {
            uint256 id = _queue[h];
            Pumpkin storage t = _p[id];
            uint256 b = t.carveBlock;
            if (block.number <= b) break;
            bytes32 hash = _hashOf(b);
            if (hash == 0) {
                // nobody settled it for over a day (8,191 blocks): its face comes from this block's hash instead,
                // and so do the faces of any others behind it that old, so one more pass a block later finishes them
                for (uint256 j = h; j < stop && j - h < max; ++j) {
                    Pumpkin storage q = _p[_queue[j]];
                    if (q.carveBlock < block.number && _hashOf(q.carveBlock) == 0) q.carveBlock = uint64(block.number);
                }
                break;
            }
            uint256 left = FOR_SALE - carved;
            uint256 r = uint256(keccak256(abi.encode(hash, id))) % left;
            uint256 v = _at(r);
            _moved[r] = _at(left - 1) + 1;
            t.edition = uint16(renderer.poolEdition(v));
            t.state = CARVED;
            ++carved;
            emit Carved(id, t.edition);
            emit MetadataUpdate(id);
            ++h;
            ++done;
        }
        head = h;
    }

    /// A block's hash: from the EVM for the last 256 blocks, then from EIP-2935's history for the last 8,191, so a carve
    /// takes its face from its own block however late it's settled (nobody gets a second roll by waiting). 0 past that.
    function _hashOf(uint256 b) internal view returns (bytes32 hash) {
        hash = blockhash(b);
        if (hash != 0) return hash;
        (bool ok, bytes memory r) = HISTORY.staticcall(abi.encode(b));
        if (ok && r.length == 32) hash = abi.decode(r, (bytes32));
    }

    function _at(uint256 slot) internal view returns (uint256) {
        uint256 m = _moved[slot];
        return m == 0 ? slot : m - 1;
    }

    /// The faces the pending carves will get, in queue order, without writing anything. Stops at the first carve
    /// from the current block (or whose hash is too old): every carve after it waits on it.
    function _playForward(uint256 until) internal view returns (uint256[] memory ids, uint256[] memory eds) {
        uint256 h = head;
        uint256 n = _queue.length - h;
        if (n > SIMULATE) n = SIMULATE;
        ids = new uint256[](n);
        eds = new uint256[](n);
        uint256[] memory keys = new uint256[](n * 2);
        uint256[] memory vals = new uint256[](n * 2);
        uint256 used;
        uint256 left = FOR_SALE - carved;
        uint256 k;
        for (; k < n; ++k) {
            uint256 id = _queue[h + k];
            uint256 b = _p[id].carveBlock;
            if (block.number <= b) break;
            bytes32 hash = _hashOf(b);
            if (hash == 0) break;
            uint256 r = uint256(keccak256(abi.encode(hash, id))) % left;
            uint256 v = _overlay(keys, vals, used, r);
            uint256 lastV = _overlay(keys, vals, used, left - 1);
            keys[used] = r;
            vals[used] = lastV;
            ++used;
            --left;
            ids[k] = id;
            eds[k] = renderer.poolEdition(v);
            if (id == until) { ++k; break; } // (lookOf only needs this far)
        }
        assembly {
            mstore(ids, k)
            mstore(eds, k)
        }
    }

    function _overlay(uint256[] memory keys, uint256[] memory vals, uint256 used, uint256 slot)
        internal
        view
        returns (uint256)
    {
        for (uint256 i = used; i > 0; --i) if (keys[i - 1] == slot) return vals[i - 1];
        return _at(slot);
    }
}
