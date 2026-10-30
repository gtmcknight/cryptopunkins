// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {CryptoPunkins} from "../src/CryptoPunkins.sol";
import {Renderer} from "../src/Renderer.sol";
import {SSTORE2} from "solady/utils/SSTORE2.sol";

/// Random players through a whole night: buying, stabbing (theirs and others', with knives that may be spent, broken
/// or not theirs, at pumpkins that may not exist), trading pumpkins, feeding the pot, settling, withdrawing the cut,
/// claiming (their own and other people's), sending everyone's shares, while the clock runs past 8 PM and midnight.
/// One player is a wallet that refuses ETH. Every ETH is tracked.
contract Night is Test {
    CryptoPunkins public game;
    address public payout;
    address[] public players;

    uint256 public paidIn; // every buy
    uint256 public fedIn; // every feed and plain send
    uint256 public claimedOut; // every claim and every share sent
    uint256 public cutOut; // every withdraw

    // anything the rules forbid that went through anyway
    string public broke;

    constructor(CryptoPunkins game_, address payout_) {
        game = game_;
        payout = payout_;
        for (uint256 i; i < 5; ++i) players.push(address(uint160(0xA0000 + i)));
        players.push(address(new Refuser())); // (it can own pumpkins, but never takes ETH)
    }

    function _balances() internal view returns (uint256 sum) {
        for (uint256 i; i < players.length; ++i) sum += players[i].balance;
    }

    function _player(uint256 seed) internal view returns (address) {
        return players[seed % players.length];
    }

    function _flag(string memory what) internal {
        if (bytes(broke).length == 0) broke = what;
    }

    function buy(uint256 who, uint256 count) external {
        address p = _player(who);
        count = bound(count, 1, 10);
        uint256 value = count * game.PRICE();
        vm.deal(p, p.balance + value);
        bool open = block.timestamp < game.salesEnd();
        vm.prank(p);
        try game.buy{value: value}(count) {
            paidIn += value;
            if (!open) _flag("bought after sales closed");
        } catch {}
    }

    function carve(uint256 who, uint256 knife, uint256 target, bool asOwner) external {
        uint256 sold = game.sold();
        if (sold == 0) return;
        knife = bound(knife, 1, sold);
        target = bound(target, 1, sold + 3); // (sometimes nobody minted it)
        address p = asOwner ? game.ownerOf(knife) : _player(who);
        address targetOwner = target <= sold ? game.ownerOf(target) : address(0);
        uint256 wholeBefore = game.whole();
        vm.prank(p);
        try game.carve(knife, target) {
            if (target > sold) _flag("carved a pumpkin nobody minted");
            if (game.ownerOf(knife) != p) _flag("carved with someone else's knife");
            if (block.timestamp >= game.end()) _flag("carved after midnight");
            if (block.timestamp < game.salesEnd() && targetOwner != p) _flag("carved someone else's before 8 PM");
            if (game.whole() != wholeBefore - 1) _flag("a carve didn't take exactly one whole pumpkin");
        } catch {}
    }

    function carveMany(uint256 who, uint256[4] calldata knives, uint256[4] calldata targets) external {
        uint256 sold = game.sold();
        if (sold == 0) return;
        address p = _player(who);
        uint256[] memory k = new uint256[](4);
        uint256[] memory t = new uint256[](4);
        for (uint256 i; i < 4; ++i) {
            k[i] = bound(knives[i], 1, sold);
            t[i] = bound(targets[i], 1, sold + 3);
        }
        uint256 wholeBefore = game.whole();
        vm.prank(p);
        try game.carveMany(k, t) returns (uint256 done) {
            if (block.timestamp >= game.end()) _flag("carved many after midnight");
            if (wholeBefore - game.whole() != done) _flag("carveMany's count doesn't match the whole pumpkins it took");
        } catch {}
    }

    function trade(uint256 id, uint256 to) external {
        uint256 sold = game.sold();
        if (sold == 0) return;
        id = bound(id, 1, sold);
        address from = game.ownerOf(id);
        vm.prank(from);
        game.transferFrom(from, _player(to), id);
    }

    function feed(uint256 amount, bool plainSend) external {
        amount = bound(amount, 0, 0.05 ether);
        vm.deal(address(this), address(this).balance + amount);
        if (plainSend) {
            (bool ok,) = address(game).call{value: amount}("");
            if (ok) fedIn += amount;
        } else {
            try game.feed{value: amount}() {
                fedIn += amount;
            } catch {}
        }
    }

    function settle(uint256 max) external {
        game.settle(bound(max, 0, 60));
    }

    /// anyone sends a run of shares out
    function sendShares(uint256 from, uint256 to) external {
        uint256 sold = game.sold();
        from = bound(from, 0, sold + 1);
        to = bound(to, from, sold + 5);
        uint256 before = _balances();
        try game.sendShares(from, to) returns (uint256 sent) {
            if (block.timestamp < game.end()) _flag("sent shares before midnight");
            if (_balances() - before != sent) _flag("sendShares says it sent more or less than it did");
        } catch {}
        claimedOut += _balances() - before;
    }

    function withdraw() external {
        uint256 before = payout.balance;
        game.withdraw();
        cutOut += payout.balance - before;
    }

    /// a player claims everything they can, and sometimes tries one that isn't theirs
    function claim(uint256 who, uint256 stranger) external {
        address p = _player(who);
        uint256 sold = game.sold();
        uint256[] memory mine = new uint256[](sold);
        uint256 n;
        for (uint256 id = 1; id <= sold; ++id) {
            uint256[] memory one = new uint256[](1);
            one[0] = id;
            if (game.ownerOf(id) == p && game.owed(one) > 0) mine[n++] = id;
        }
        assembly {
            mstore(mine, n)
        }
        uint256 before = p.balance;
        vm.prank(p);
        try game.claim(mine) {
            if (block.timestamp < game.end()) _flag("claimed before midnight");
        } catch {}
        claimedOut += p.balance - before;

        if (sold == 0) return;
        // one of their own that's owed nothing (carved, or already paid): it pays nothing
        for (uint256 id = 1 + stranger % sold; id <= sold; ++id) {
            uint256[] memory one = new uint256[](1);
            one[0] = id;
            if (game.ownerOf(id) != p || game.owed(one) != 0) continue;
            before = p.balance;
            vm.prank(p);
            try game.claim(one) {} catch {}
            if (p.balance != before) _flag("claimed a pumpkin that was owed nothing");
            claimedOut += p.balance - before;
            break;
        }
        uint256[] memory theirs = new uint256[](1);
        theirs[0] = bound(stranger, 1, sold);
        if (game.ownerOf(theirs[0]) == p) return;
        before = p.balance;
        vm.prank(p);
        try game.claim(theirs) {
            _flag("claimed a pumpkin someone else owns");
        } catch {}
        claimedOut += p.balance - before;
    }

    /// time passes: a minute to two hours, and blocks with hashes, as on mainnet
    function wait(uint256 secs, uint256 blocks) external {
        vm.warp(block.timestamp + bound(secs, 1 minutes, 2 hours));
        blocks = bound(blocks, 1, 40);
        for (uint256 i; i < blocks; ++i) {
            uint256 b = vm.getBlockNumber();
            vm.setBlockhash(b, keccak256(abi.encode("block", b)));
            vm.roll(b + 1);
        }
    }

    receive() external payable {}
}

contract InvariantTest is StdInvariant, Test {
    CryptoPunkins game;
    Night night;
    uint256 constant END = 1793505600;
    address payout = address(0xC0FFEE);

    function setUp() public {
        vm.warp(END - 10 hours); // (six hours of sales, then the night)
        vm.roll(1000);
        Renderer renderer = new Renderer(
            vm.readFileBinary("../data/art.bin"), vm.readFileBinary("../data/traits.bin"), SSTORE2.write(vm.readFileBinary("../data/editions.bin"))
        );
        game = new CryptoPunkins(renderer, END, payout, address(0xFE35));
        night = new Night(game, payout);
        targetContract(address(night));
        bytes4[] memory moves = new bytes4[](10);
        moves[0] = Night.buy.selector;
        moves[1] = Night.carve.selector;
        moves[2] = Night.carveMany.selector;
        moves[3] = Night.trade.selector;
        moves[4] = Night.feed.selector;
        moves[5] = Night.settle.selector;
        moves[6] = Night.withdraw.selector;
        moves[7] = Night.claim.selector;
        moves[8] = Night.wait.selector;
        moves[9] = Night.sendShares.selector;
        targetSelector(FuzzSelector({addr: address(night), selectors: moves}));
    }

    /// nothing the rules forbid ever went through
    function invariant_rules_hold() public view {
        assertEq(night.broke(), "");
    }

    /// every wei is accounted for: what came in, less what was claimed and withdrawn, is exactly what the game holds
    function invariant_every_wei_accounted_for() public view {
        assertEq(address(game).balance, night.paidIn() + night.fedIn() - night.claimedOut() - night.cutOut());
        assertEq(game.fed(), night.fedIn());
        assertEq(night.paidIn(), game.sold() * game.PRICE());
    }

    /// the claims never take more than the pot, the cut never more than its 10%, and what's still owed is all there
    function invariant_the_pot_is_always_covered() public view {
        uint256 sold = game.sold();
        assertLe(night.claimedOut(), game.pot());
        assertLe(night.cutOut(), sold * game.CUT());
        uint256[] memory all = new uint256[](sold);
        for (uint256 i; i < sold; ++i) all[i] = i + 1;
        uint256 stillOwed = game.owed(all);
        uint256 cutLeft = sold * game.CUT() - night.cutOut();
        assertLe(stillOwed + cutLeft, address(game).balance);
        assertLe(night.claimedOut() + stillOwed, game.pot());
    }

    /// after midnight nothing gets stuck: everything left is someone's share still owed, the cut, or division dust
    function invariant_nothing_gets_stuck() public view {
        uint256 sold = game.sold();
        // (with nothing ever sold there's nobody to share it: what was fed stays, as the runbook says)
        if (block.timestamp < game.end() || sold == 0) return;
        uint256[] memory all = new uint256[](sold);
        for (uint256 i; i < sold; ++i) all[i] = i + 1;
        uint256 cutLeft = sold * game.CUT() - night.cutOut();
        uint256 sharers = game.whole() != 0 ? game.whole() : sold;
        assertLe(address(game).balance - cutLeft - game.owed(all), sharers);
    }

    /// every pumpkin sold is exactly one of whole, being carved, or carved, and the counts agree with the patch
    function invariant_every_pumpkin_counted_once() public view {
        (uint256 sold, uint256 carved, uint256 whole, uint256 pending,,,,) = game.stats();
        assertEq(whole + pending + carved, sold);
        if (sold == 0) return;
        (, uint256[] memory words) = game.patch(1, sold);
        uint256 wholeSeen;
        for (uint256 i; i < words.length; ++i) {
            uint256 look = words[i] & 0xff;
            uint256 left = (words[i] >> 24) & 0xff;
            assertLe(left, 2);
            if (look == 0 || look == 3) ++wholeSeen;
            else assertEq(left, 0); // (a cut pumpkin has no knives left)
        }
        assertEq(wholeSeen, whole);
    }
}

/// A wallet that never takes ETH.
contract Refuser {
    receive() external payable {
        revert("no ETH");
    }
}
