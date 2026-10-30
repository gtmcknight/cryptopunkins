// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";
import {CryptoPunkins} from "../src/CryptoPunkins.sol";
import {Renderer} from "../src/Renderer.sol";
import {SSTORE2} from "solady/utils/SSTORE2.sol";

contract CryptoPunkinsTest is Test {
    CryptoPunkins game;
    Renderer renderer;
    uint256 constant END = 1793505600; // 2026-11-01 00:00 New York
    uint256 constant P = 0.00666 ether;
    address payout = makeAddr("payout");

    function setUp() public {
        vm.warp(END - 2 days);
        vm.roll(1000);
        _hashes();
        renderer = new Renderer(
            vm.readFileBinary("../data/art.bin"), vm.readFileBinary("../data/traits.bin"), SSTORE2.write(vm.readFileBinary("../data/editions.bin"))
        );
        game = new CryptoPunkins(renderer, END, payout, address(0xFE35));
    }

    // a hash for every block, as on mainnet
    function _hashes() internal {
        uint256 now_ = vm.getBlockNumber();
        for (uint256 b = now_ > 256 ? now_ - 256 : 0; b < now_; ++b) {
            vm.setBlockhash(b, keccak256(abi.encode("block", b)));
        }
    }

    // (vm.getBlockNumber, not block.number: via-ir can reuse one block.number read across a whole test)
    function _next(uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            uint256 b = vm.getBlockNumber();
            vm.setBlockhash(b, keccak256(abi.encode("block", b)));
            vm.roll(b + 1);
        }
    }

    // carving opens at 8 PM on Halloween, when sales close
    function _open() internal {
        vm.warp(END - game.LAST_CALL());
    }

    function _buyer(uint256 i) internal returns (address a) {
        a = address(uint160(0x10000 + i));
        vm.deal(a, 1 ether);
    }

    function _buy(address who, uint256 n) internal returns (uint256 first) {
        first = game.sold() + 1;
        uint256 value = n * game.PRICE(); // (a prank covers only the next call, so price it first)
        vm.prank(who);
        game.buy{value: value}(n);
    }

    // ------------------------------------------------------------------ sale

    function test_nothing_is_minted_until_someone_buys() public {
        assertEq(game.sold(), 0);
        vm.expectRevert();
        game.ownerOf(1);
        // every 2021 face is in the pool
        for (uint256 s; s < 1031; ++s) assertEq(renderer.poolEdition(s), s + 1);
    }

    function test_an_uncut_pumpkin_wears_its_colour() public {
        address a = _buyer(1);
        _buy(a, 10);
        bool[5] memory seen;
        for (uint256 id = 1; id <= 10; ++id) {
            uint256 c = renderer.colourOf(id);
            assertLt(c, 5);
            seen[c] = true;
            string memory json = string(Base64.decode(LibString.slice(game.tokenURI(id), 29)));
            assertTrue(LibString.contains(json, '"trait_type":"Colour"'));
        }
        uint256 kinds;
        for (uint256 c; c < 5; ++c) if (seen[c]) ++kinds;
        assertGt(kinds, 2); // (ten in a row aren't all one colour)
        // the colour changes the picture, and orange is the art as packed
        assertFalse(keccak256(bytes(renderer.svgIn(0, 0, false, 1))) == keccak256(bytes(renderer.svgIn(0, 0, false, 0))));
        assertEq(keccak256(bytes(renderer.svgIn(0, 0, false, 0))), keccak256(bytes(renderer.svgAt(0, 0, false))));
    }

    function test_buy_rules() public {
        address a = _buyer(1);
        vm.startPrank(a);
        vm.expectRevert(CryptoPunkins.WrongPrice.selector);
        game.buy{value: 0.0006 ether}(1);
        vm.expectRevert(CryptoPunkins.TooMany.selector);
        game.buy{value: 0}(0);
        vm.expectRevert(CryptoPunkins.TooMany.selector);
        game.buy{value: 11 * P}(11);
        game.buy{value: 10 * P}(10);
        game.buy{value: 10 * P}(10); // (no limit per wallet, only per buy)
        assertEq(game.balanceOf(a), 20);
        assertEq(game.ownerOf(1), a);
        vm.stopPrank();
        // sales close three hours before midnight; carving runs on
        address b = _buyer(2);
        vm.warp(END - game.LAST_CALL() - 1);
        _buy(b, 1);
        vm.warp(END - game.LAST_CALL());
        vm.prank(b);
        vm.expectRevert(CryptoPunkins.Closed.selector);
        game.buy{value: P}(1);
        vm.prank(b);
        game.carve(21, 1);
        vm.warp(END);
        vm.prank(a);
        vm.expectRevert(CryptoPunkins.Closed.selector);
        game.carve(1, 21);
    }

    function test_sells_out_at_1031() public {
        for (uint256 i; i < 103; ++i) _buy(_buyer(i), 10);
        _buy(_buyer(103), 1);
        assertEq(game.sold(), 1031);
        address late = _buyer(999);
        vm.prank(late);
        vm.expectRevert(CryptoPunkins.SoldOut.selector);
        game.buy{value: P}(1);
        assertEq(address(game).balance, 1031 * P);
        assertEq(game.pot(), 1031 * (P - P / 10));
        assertEq(game.whole(), 1031);
        game.withdraw(); // the 10% cut, sent by anyone
        assertEq(payout.balance, 1031 * (P / 10));
        assertEq(address(game).balance, game.pot());
        game.withdraw(); // nothing more until more sells
        assertEq(payout.balance, 1031 * (P / 10));
    }

    // ------------------------------------------------------------------ the pot

    function test_the_great_pumpkins_split_the_pot() public {
        address a = _buyer(1);
        address b = _buyer(2);
        address c = _buyer(3);
        uint256 ka = _buy(a, 3); // 1-3
        uint256 kb = _buy(b, 2); // 4-5
        uint256 kc = _buy(c, 1); // 6
        uint256 each = P - P / 10;
        assertEq(game.share(), each); // all whole: everyone would just get their stake back
        _open();
        vm.prank(b);
        game.carve(kb, ka); // 1 carved, and its unused knife breaks
        vm.prank(a);
        vm.expectRevert(CryptoPunkins.KnifeBroken.selector);
        game.carve(ka, kb + 1);
        vm.prank(a);
        game.carve(ka + 1, kb); // 4 carved (its knife was already used)
        vm.prank(c);
        game.carve(kc, kb + 1); // 5 carved, its knife breaks
        vm.prank(a);
        game.carve(ka + 2, kc); // 6 carved
        assertEq(game.whole(), 2); // 2 and 3, both a's
        uint256 pot = 6 * each;
        assertEq(game.pot(), pot);
        assertEq(game.share(), pot / 2);

        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (ka + 1, ka + 2);
        vm.prank(a);
        vm.expectRevert(CryptoPunkins.TooEarly.selector);
        game.claim(ids);
        vm.warp(END);
        _next(2);
        game.settle(10);
        vm.prank(b);
        vm.expectRevert(CryptoPunkins.NotYours.selector);
        game.claim(ids);
        uint256[] memory carvedOne = new uint256[](1);
        carvedOne[0] = ka; // a owns 1, but it was carved
        vm.prank(a);
        vm.expectRevert(CryptoPunkins.NoShare.selector);
        game.claim(carvedOne);
        uint256 before = a.balance;
        vm.prank(a);
        game.claim(ids);
        assertEq(a.balance - before, pot);
        game.withdraw();
        assertEq(payout.balance, 6 * (P / 10));
        assertEq(address(game).balance, 0);
        vm.prank(a);
        vm.expectRevert(CryptoPunkins.AlreadyPaid.selector);
        game.claim(ids);
        (, uint256[] memory words) = game.patch(ka + 1, ka + 1);
        assertEq((words[0] >> 208) & 0xff, 1); // the site sees it's been paid
        assertEq(words[0] & 0xff, 3); // a Great Pumpkin
    }

    /// After midnight anyone can send every Great Pumpkin its share: nobody has to come back for it, nothing is sent
    /// twice, and whatever is fed to the pot later goes out on the next send.
    function test_shares_go_out_without_anyone_claiming() public {
        address a = _buyer(1);
        address b = _buyer(2);
        address c = _buyer(3);
        _buy(a, 3); // 1-3
        _buy(b, 2); // 4-5
        _buy(c, 1); // 6
        _open();
        vm.prank(b);
        game.carve(4, 1); // 1 (a's) carved
        vm.prank(c);
        game.carve(6, 5); // 5 (b's) carved; 6 used its knife but stays whole
        assertEq(game.whole(), 4); // 2, 3 (a), 4 (b), 6 (c)
        vm.expectRevert(CryptoPunkins.TooEarly.selector);
        game.sendShares(1, 1031);

        vm.warp(END);
        _next(2);
        uint256 each = game.pot() / 4;
        (uint256 ba, uint256 bb, uint256 bc) = (a.balance, b.balance, c.balance);
        vm.prank(makeAddr("anyone"));
        assertEq(game.sendShares(1, 1031), 4 * each);
        assertEq(a.balance - ba, 2 * each);
        assertEq(b.balance - bb, each);
        assertEq(c.balance - bc, each);
        assertEq(game.sendShares(1, 1031), 0); // nothing twice
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (2, 3);
        vm.prank(a);
        vm.expectRevert(CryptoPunkins.AlreadyPaid.selector);
        game.claim(ids);

        // fed after midnight: the next send shares it out
        vm.deal(address(this), 1 ether);
        game.feed{value: 0.04 ether}();
        uint256 more = game.pot() / 4 - each;
        assertEq(game.sendShares(1, 1031), 4 * more);
        assertEq(a.balance - ba, 2 * (each + more));
        game.withdraw();
        assertLt(address(game).balance, 4); // (only the division's dust)
    }

    /// A wallet that refuses ETH, or burns all the gas it's given, is skipped: everyone else is paid in the same call,
    /// and the skipped share stays owed for a claim later.
    function test_a_wallet_that_refuses_eth_is_skipped_and_stays_owed() public {
        Picky picky = new Picky(game);
        Burner burner = new Burner(game);
        vm.deal(address(picky), 1 ether);
        vm.deal(address(burner), 1 ether);
        picky.buy(1); // 1
        burner.buy(1); // 2
        address a = _buyer(1);
        _buy(a, 1); // 3
        vm.warp(END);
        _next(2);
        uint256 each = game.pot() / 3;
        uint256 before = a.balance;
        game.sendShares{gas: 1_000_000}(1, 3); // (the burner gets its 50,000 and no more)
        assertEq(a.balance - before, each);
        uint256[] memory one = new uint256[](1);
        one[0] = 1;
        assertEq(game.owed(one), each);
        one[0] = 2;
        assertEq(game.owed(one), each);
        assertEq(address(game).balance, 3 * P - each);

        picky.allow();
        uint256 pb = address(picky).balance;
        picky.claim(1);
        assertEq(address(picky).balance - pb, each);
    }

    /// A wallet can't reach back in while it's being paid: it gets its share once.
    function test_a_paid_wallet_cannot_reenter() public {
        Greedy greedy = new Greedy(game);
        vm.deal(address(greedy), 1 ether);
        greedy.buy(2); // 1-2
        address a = _buyer(1);
        _buy(a, 1); // 3
        vm.warp(END);
        _next(2);
        uint256 each = game.pot() / 3;
        uint256 gb = address(greedy).balance;
        game.sendShares(1, 3);
        assertEq(address(greedy).balance - gb, 2 * each);
        assertGt(greedy.tries(), 0); // it did try
        assertLt(address(game).balance, 3 * (P / 10) + 3);
    }

    /// After midnight a pumpkin's metadata says whether its share has gone out, and marketplaces hear when it does, so
    /// nobody buys a paid Great Pumpkin thinking the share comes with it.
    function test_pot_share_shows_in_the_metadata() public {
        address a = _buyer(1);
        address b = _buyer(2);
        _buy(a, 1); // 1
        _buy(b, 1); // 2
        _open();
        vm.prank(a);
        game.carve(1, 2); // 2 carved: 1 is the only Great Pumpkin
        string memory json = string(Base64.decode(LibString.slice(game.tokenURI(1), 29)));
        assertFalse(LibString.contains(json, '"Pot share"')); // (not midnight yet)
        vm.warp(END);
        _next(2);
        game.settle(10);
        json = string(Base64.decode(LibString.slice(game.tokenURI(1), 29)));
        assertTrue(LibString.contains(json, '"trait_type":"Pot share","value":"Unpaid"'));
        json = string(Base64.decode(LibString.slice(game.tokenURI(2), 29)));
        assertFalse(LibString.contains(json, '"Pot share"')); // (carved: no share)
        vm.expectEmit(address(game));
        emit CryptoPunkins.MetadataUpdate(1);
        game.sendShares(1, 2);
        json = string(Base64.decode(LibString.slice(game.tokenURI(1), 29)));
        assertTrue(LibString.contains(json, '"trait_type":"Pot share","value":"Paid"'));
        // fed later: owed again until it goes out
        vm.deal(address(this), 1 ether);
        game.feed{value: 0.01 ether}();
        json = string(Base64.decode(LibString.slice(game.tokenURI(1), 29)));
        assertTrue(LibString.contains(json, '"trait_type":"Pot share","value":"Unpaid"'));
    }

    /// Nothing is owed to a pumpkin nobody minted, and settling with any max never overflows, even past expired hashes.
    function test_owed_and_settle_edges() public {
        address a = _buyer(1);
        _buy(a, 2);
        vm.prank(a);
        game.carve(1, 2); // its own, before 8 PM
        vm.roll(vm.getBlockNumber() + 300); // (its block's hash has expired: no history contract here)
        game.settle(type(uint256).max); // rolls it to this block
        _next(1);
        game.settle(type(uint256).max);
        (,,, uint256 pending,,,,) = game.stats();
        assertEq(pending, 0);
        vm.warp(END);
        uint256[] memory ids = new uint256[](3);
        (ids[0], ids[1], ids[2]) = (0, 3, 1031);
        assertEq(game.owed(ids), 0);
        ids[0] = 1;
        assertEq(game.owed(ids), game.share());
    }

    /// The cost of sending: about 40,000 gas a Great Pumpkin.
    function test_gas_to_send_100_shares() public {
        for (uint256 i; i < 10; ++i) _buy(_buyer(i), 10);
        vm.warp(END);
        _next(2);
        uint256 g = gasleft();
        game.sendShares(1, 1031);
        g -= gasleft();
        emit log_named_uint("gas to send 100 shares", g);
        assertLt(g, 100 * 45_000);
    }

    /// A coin's fees (or anyone) can feed the pot: before midnight it grows the prize, after it pays the Great
    /// Pumpkins as it arrives, claimable again and again.
    function test_the_pot_takes_coin_fees_forever() public {
        address a = _buyer(1);
        address b = _buyer(2);
        address coin = _buyer(3);
        uint256 ka = _buy(a, 2); // 1, 2
        uint256 kb = _buy(b, 1); // 3
        _open();
        vm.prank(b);
        game.carve(kb, ka); // 1 carved
        vm.prank(a);
        game.carve(ka + 1, kb); // 3 carved: 2 is the only one whole
        vm.prank(coin);
        game.feed{value: 0.1 ether}();
        vm.prank(coin);
        (bool ok,) = address(game).call{value: 0.05 ether}(""); // fees pushed by a plain send work too
        assertTrue(ok);
        uint256 pot = 3 * (P - P / 10) + 0.15 ether;
        assertEq(game.pot(), pot);
        assertEq(game.share(), pot);
        vm.warp(END);
        uint256[] memory ids = new uint256[](1);
        ids[0] = ka + 1;
        assertEq(game.owed(ids), pot);
        uint256 before = a.balance;
        vm.prank(a);
        game.claim(ids);
        assertEq(a.balance - before, pot);
        assertEq(game.owed(ids), 0);
        (, uint256[] memory words) = game.patch(ka + 1, ka + 1);
        assertEq((words[0] >> 208) & 0xff, 1); // paid up
        vm.prank(a);
        vm.expectRevert(CryptoPunkins.AlreadyPaid.selector);
        game.claim(ids);
        // after midnight, more fees: the Great Pumpkin can claim them too
        vm.prank(coin);
        game.feed{value: 0.02 ether}();
        assertEq(game.owed(ids), 0.02 ether);
        (, words) = game.patch(ka + 1, ka + 1);
        assertEq((words[0] >> 208) & 0xff, 0);
        before = a.balance;
        vm.prank(a);
        game.claim(ids);
        assertEq(a.balance - before, 0.02 ether);
        game.withdraw();
        assertEq(payout.balance, 3 * (P / 10)); // the cut is only ever 10% of sales
        assertEq(address(game).balance, 0);
    }

    /// One click at 9 PM: all of a wallet's knives in one transaction, skipping what someone else got to first.
    function test_carve_many_at_nine() public {
        address a = _buyer(1);
        address b = _buyer(2);
        address c = _buyer(3);
        uint256 ka = _buy(a, 2); // 1, 2: four knives
        uint256 kb = _buy(b, 2); // 3, 4
        uint256 kc = _buy(c, 2); // 5, 6
        uint256[] memory knives = new uint256[](4);
        uint256[] memory targets = new uint256[](4);
        (knives[0], knives[1], knives[2], knives[3]) = (ka, ka, ka + 1, ka + 1);
        (targets[0], targets[1], targets[2], targets[3]) = (kb, kb + 1, kc, kc + 1);
        vm.prank(a);
        vm.expectRevert(CryptoPunkins.NotWhole.selector); // before 9 PM, none of these can happen
        game.carveMany(knives, targets);
        _open();
        vm.prank(c);
        game.carve(kc + 1, kc); // c's 5 gets carved by c's other pumpkin first... (own: allowed)
        vm.prank(a);
        uint256 done = game.carveMany(knives, targets);
        assertEq(done, 3); // 3, 4 and 6; 5 was already gone
        assertEq(game.whole(), 2); // a's own two
        vm.prank(b);
        vm.expectRevert(CryptoPunkins.NotWhole.selector); // b's knives all broke: nothing to do
        game.carveMany(knives, targets);
    }

    /// Your own you can carve any time, just to see its face: it uses its own knife (the other breaks) and leaves the
    /// pot. Anyone else's waits for 9 PM.
    function test_you_can_carve_your_own_any_time() public {
        address a = _buyer(1);
        address b = _buyer(2);
        uint256 ka = _buy(a, 1);
        uint256 kb = _buy(b, 1);
        vm.startPrank(a);
        vm.expectRevert(CryptoPunkins.NotCarvingYet.selector);
        game.carve(ka, kb);
        game.carve(ka, ka);
        vm.stopPrank();
        _open();
        vm.prank(a);
        vm.expectRevert(CryptoPunkins.KnifeBroken.selector); // its other knife broke
        game.carve(ka, kb);
        assertEq(game.whole(), 1);
        _next(1);
        (uint256 look, uint256 e) = game.lookOf(ka);
        assertEq(look, 2);
        assertGt(e, 0);
        assertEq(game.carverOf(ka), a);
    }

    /// If everything gets carved (people can carve their own), every pumpkin sold takes an equal share back.
    function test_nothing_whole_every_pumpkin_sold_shares_it() public {
        address a = _buyer(1);
        address b = _buyer(2);
        uint256 ka = _buy(a, 1);
        uint256 kb = _buy(b, 1);
        vm.prank(a);
        game.carve(ka, ka);
        vm.prank(b);
        game.carve(kb, kb);
        assertEq(game.whole(), 0);
        assertEq(game.share(), P - P / 10);
        vm.warp(END);
        uint256[] memory ids = new uint256[](1);
        ids[0] = ka;
        uint256 before = a.balance;
        vm.prank(a);
        game.claim(ids);
        assertEq(a.balance - before, P - P / 10);
        ids[0] = kb;
        vm.prank(b);
        game.claim(ids);
        game.withdraw();
        assertEq(address(game).balance, 0);
    }

    // ------------------------------------------------------------------ carving

    function test_carve_rules() public {
        address a = _buyer(1);
        address b = _buyer(2);
        address c = _buyer(3);
        uint256 ka = _buy(a, 2); // 1, 2
        uint256 kb = _buy(b, 1); // 3
        uint256 kc = _buy(c, 2); // 4, 5
        vm.prank(a);
        vm.expectRevert(CryptoPunkins.NotCarvingYet.selector);
        game.carve(ka, kb);
        _open();
        vm.startPrank(a);
        vm.expectRevert(CryptoPunkins.NotYourKnife.selector);
        game.carve(kb, ka);
        game.carve(ka, kb);
        vm.expectRevert(CryptoPunkins.NotWhole.selector);
        game.carve(ka, kb); // already being carved
        game.carve(ka, kc); // 1's second knife
        vm.expectRevert(CryptoPunkins.KnifeUsed.selector);
        game.carve(ka, kc + 1); // and it has no third
        vm.stopPrank();
        vm.prank(b);
        vm.expectRevert(CryptoPunkins.KnifeBroken.selector); // b's pumpkin was carved before b used its knives
        game.carve(kb, ka + 1);
        (uint256 look,) = game.lookOf(kb);
        assertEq(look, 1); // its next block hasn't happened
        assertEq(game.carverOf(kb), a);
    }

    /// A knife only carves a pumpkin that exists: after 8 PM too, a made-up id can't be carved, or counted out of the
    /// pot (that would hand the last ones whole a share of pumpkins that never were).
    function test_cannot_carve_a_pumpkin_nobody_minted() public {
        address a = _buyer(1);
        address b = _buyer(2);
        uint256 ka = _buy(a, 2);
        _buy(b, 1);
        _open();
        uint256 before = game.whole();
        uint256[3] memory fake = [uint256(0), game.sold() + 1, 5000];
        for (uint256 i; i < 3; ++i) {
            vm.prank(a);
            vm.expectRevert(bytes4(keccak256("TokenDoesNotExist()"))); // (solady ERC721)
            game.carve(ka, fake[i]);
        }
        assertEq(game.whole(), before);
    }

    /// A carve nobody settles for a while still takes its face from its own block (EIP-2935 keeps 8,191 hashes), so
    /// its carver can't wait out a face they don't like for a new roll.
    function test_a_late_settle_keeps_its_own_block() public {
        vm.etch(0x0000F90827F1C53a10cb7A02335B175320002935, address(new History()).code);
        address a = _buyer(1);
        uint256 ka = _buy(a, 1);
        uint256 at = vm.getBlockNumber();
        vm.prank(a);
        game.carve(ka, ka); // its own, before 8 PM
        _next(300); // past the EVM's 256
        game.settle(1);
        (uint256 look, uint256 edition) = game.lookOf(ka);
        assertEq(look, 2);
        bytes32 hash = keccak256(abi.encode("history", at));
        assertEq(edition, uint256(keccak256(abi.encode(hash, ka))) % 1031 + 1);
    }

    /// Marketplaces read tokenURI with eth_call; keep the heaviest picture (a carved one on Oct 31, lit) under one
    /// transaction's gas (2^24), in case a node holds calls to that.
    function test_heaviest_token_uri_fits_a_transaction() public {
        vm.warp(1793419200 + 12 hours); // Oct 31, lit
        uint256 worst;
        uint256 worstEdition;
        address r = address(renderer);
        for (uint256 e = 1; e <= 1031; ++e) {
            bytes memory call_ = abi.encodeCall(Renderer.tokenURI, (1, 2, e, address(this), 0, true, 0, 0, 0));
            uint256 g0 = gasleft();
            bool ok;
            // (each call in its own frame, its answer left there, so this frame's memory doesn't grow and skew the count)
            assembly {
                ok := staticcall(gas(), r, add(call_, 32), mload(call_), 0, 0)
            }
            uint256 used = g0 - gasleft();
            assertTrue(ok);
            if (used > worst) (worst, worstEdition) = (used, e);
        }
        emit log_named_uint("heaviest tokenURI, lit", worst);
        emit log_named_uint("its edition", worstEdition);
        assertLt(worst, 16_777_216);
    }

    function test_face_shows_the_next_block_and_matches_settle() public {
        address a = _buyer(1);
        address b = _buyer(2);
        uint256 ka = _buy(a, 1);
        uint256 kb = _buy(b, 1);
        _open();
        vm.prank(a);
        game.carve(ka, kb);
        (uint256 look,) = game.lookOf(kb);
        assertEq(look, 1); // still the carve's own block: its hash isn't known yet
        _next(1);
        (uint256 look2, uint256 shown) = game.lookOf(kb);
        assertEq(look2, 2);
        game.settle(10);
        (uint256 look3, uint256 stored) = game.lookOf(kb);
        assertEq(look3, 2);
        assertEq(stored, shown);
    }

    /// The site reads knives and carvers from patch(): every field has to come back as written.
    function test_patch_words_carry_every_field() public {
        address a = _buyer(1);
        address b = _buyer(2);
        uint256 ka = _buy(a, 1);
        uint256 kb = _buy(b, 1);
        _open();
        vm.prank(a);
        game.carve(ka, kb);
        _next(1);
        (address[] memory owners, uint256[] memory words) = game.patch(ka, kb);
        assertEq(owners[0], a);
        uint256 wa = words[0];
        uint256 wb = words[1];
        assertEq(wa & 0xff, 0); // whole
        assertEq((wa >> 24) & 0xff, 1); // a has one knife left
        assertEq((wa >> 32) & 0xffff, kb); // the other carved b's pumpkin
        assertEq(wb & 0xff, 2); // b's pumpkin shows its face
        (, uint256 e) = game.lookOf(kb);
        assertEq((wb >> 8) & 0xffff, e);
        assertEq((wb >> 24) & 0xff, 0); // b's knives broke when a carved b's pumpkin
        assertEq((wb >> 232) & 0xff, 1);
        assertEq((wb >> 32) & 0xffff, 0); // and never carved anything
        assertEq(address(uint160(wb >> 48)), a); // carved by a
    }

    /// After a quiet spell (say, after midnight), every carve whose hash expired rolls again in one pass.
    function test_old_hashes_all_roll_again_together() public {
        address a = _buyer(1);
        address b = _buyer(2);
        uint256 ka = _buy(a, 2);
        uint256 kb = _buy(b, 2);
        _open();
        vm.startPrank(a);
        game.carve(ka, kb);
        _next(1);
        game.carve(ka, kb + 1);
        vm.stopPrank();
        vm.roll(vm.getBlockNumber() + 400); // both hashes gone
        game.settle(10);
        _next(1);
        game.settle(10);
        (uint256 l1,) = game.lookOf(kb);
        (uint256 l2,) = game.lookOf(kb + 1);
        assertEq(l1, 2);
        assertEq(l2, 2);
        assertEq(game.carved(), 2);
    }

    function test_old_hash_rolls_again_from_the_next_block() public {
        address a = _buyer(1);
        address b = _buyer(2);
        uint256 ka = _buy(a, 1);
        uint256 kb = _buy(b, 1);
        _open();
        vm.prank(a);
        game.carve(ka, kb);
        vm.roll(vm.getBlockNumber() + 400); // nobody touched it: the hash is gone
        game.settle(10);
        (uint256 look,) = game.lookOf(kb);
        assertEq(look, 1);
        _next(2);
        game.settle(10);
        (uint256 look2, uint256 e) = game.lookOf(kb);
        assertEq(look2, 2);
        assertGt(e, 0);
    }

    function test_marketplaces_hear_about_carves_and_great_pumpkins() public {
        assertTrue(game.supportsInterface(0x49064906));
        address a = _buyer(1);
        address b = _buyer(2);
        uint256 ka = _buy(a, 1);
        uint256 kb = _buy(b, 1);
        _open();
        vm.expectEmit(address(game));
        emit CryptoPunkins.MetadataUpdate(kb);
        vm.prank(a);
        game.carve(ka, kb);
        _next(1);
        vm.expectEmit(address(game));
        emit CryptoPunkins.MetadataUpdate(kb);
        game.settle(10);
        vm.warp(END);
        vm.expectEmit(address(game));
        emit CryptoPunkins.BatchMetadataUpdate(1, 2);
        game.settle(10);
    }

    function test_halloween_is_oct_31_in_new_york_every_year() public view {
        assertFalse(renderer.isHalloween(1793419199)); // 2026-10-31 03:59:59 UTC = Oct 30, 23:59:59 New York
        assertTrue(renderer.isHalloween(1793419200)); // 2026-10-31 04:00 UTC = midnight in New York
        assertTrue(renderer.isHalloween(END - 1)); // the last second of the game
        assertFalse(renderer.isHalloween(END)); // midnight: Nov 1
        assertTrue(renderer.isHalloween(1824940800 + 16 hours)); // 2027-10-31, noon in New York
        assertTrue(renderer.isHalloween(4128624000 + 4 hours + 1)); // 2100-10-31, after a non-leap 2100
        assertFalse(renderer.isHalloween(4128624000 + 4 hours - 1)); // 2100-10-30 in New York
        assertFalse(renderer.isHalloween(1793505600 + 300 days));
    }

    function test_lights_up_and_tells_marketplaces() public {
        address a = _buyer(1);
        _buy(a, 1);
        vm.warp(1793419200); // midnight, Oct 31 New York
        vm.expectEmit(address(game));
        emit CryptoPunkins.BatchMetadataUpdate(1, 1);
        game.settle(1);
        assertTrue(LibString.contains(renderer.svg(0, 0), "fill=\"#")); // still draws
        assertFalse(keccak256(bytes(renderer.svgAt(2, 586, true))) == keccak256(bytes(renderer.svgAt(2, 586, false))));
    }

    function test_great_pumpkins_after_midnight() public {
        address a = _buyer(1);
        uint256 ka = _buy(a, 1);
        vm.warp(END);
        (uint256 look,) = game.lookOf(ka);
        assertEq(look, 3);
        address b = _buyer(2);
        vm.expectRevert(CryptoPunkins.Closed.selector);
        vm.prank(b);
        game.carve(1, ka);
        assertTrue(bytes(game.tokenURI(ka)).length > 0);
    }

    /// As many of the 1,031 carved as the knives allow, in a mess of blocks: knife n carves pumpkin n + 5 (the next
    /// wallet's), last first, so each knife is used before its own pumpkin is carved. 1,026 carves, no face twice,
    /// and what the view showed before settling is what got stored.
    function test_faces_never_repeat() public {
        address[] memory w = new address[](207);
        for (uint256 i; i < 207; ++i) {
            w[i] = _buyer(i);
            _buy(w[i], i == 206 ? 1 : 5);
        }
        _open();
        for (uint256 n = 1026; n >= 1; --n) {
            vm.prank(w[(n - 1) / 5]);
            game.carve(n, n + 5);
            if (n % 37 == 0) _next(1 + (n % 3));
        }
        _next(2);
        assertEq(game.whole(), 5); // wallet 0's, which no knife reached
        uint256[] memory shown = new uint256[](1032);
        (address[] memory owners, uint256[] memory words) = game.patch(1, 1031);
        assertEq(owners.length, 1031);
        for (uint256 i; i < words.length; ++i) if ((words[i] & 0xff) == 2) shown[i + 1] = (words[i] >> 8) & 0xffff;
        for (uint256 n = 1027; n <= 1031; ++n) assertEq((words[n - 1] >> 232) & 0xff, 1); // broke before they were used
        while (game.head() < 1026) game.settle(64);
        assertEq(game.carved(), 1026);
        bool[1032] memory seen;
        for (uint256 id = 6; id <= 1031; ++id) {
            (uint256 look, uint256 e) = game.lookOf(id);
            assertEq(look, 2);
            assertFalse(seen[e]);
            seen[e] = true;
            if (shown[id] != 0) assertEq(shown[id], e);
        }
    }

    // ------------------------------------------------------------------ art

    function test_token_uri_is_json_with_an_svg() public {
        address a = _buyer(1);
        address b = _buyer(2);
        uint256 ka = _buy(a, 1);
        uint256 kb = _buy(b, 1);
        string memory whole = game.tokenURI(kb);
        assertTrue(LibString.startsWith(whole, "data:application/json;base64,"));
        string memory json = string(Base64.decode(LibString.slice(whole, 29)));
        assertTrue(LibString.contains(json, '"name":"Pumpkin #'));
        assertTrue(LibString.contains(json, '"value":"Whole"'));
        assertTrue(LibString.contains(json, '"trait_type":"Colour"'));
        _open();
        vm.prank(a);
        game.carve(ka, kb);
        _next(2);
        json = string(Base64.decode(LibString.slice(game.tokenURI(kb), 29)));
        assertTrue(LibString.contains(json, '"value":"Carving"')); // (until it's settled, which tells marketplaces)
        game.settle(10);
        json = string(Base64.decode(LibString.slice(game.tokenURI(kb), 29)));
        assertTrue(LibString.contains(json, '"name":"CryptoPunkin #'));
        assertTrue(LibString.contains(json, '"trait_type":"Carved by"'));
        json = string(Base64.decode(LibString.slice(game.tokenURI(ka), 29)));
        assertTrue(LibString.contains(json, '"trait_type":"Stabs","value":"1"'));
        assertTrue(LibString.contains(json, string.concat('"trait_type":"Carved","value":"#', LibString.toString(kb), '"')));
        json = string(Base64.decode(LibString.slice(game.tokenURI(kb), 29)));
        assertTrue(LibString.contains(json, '"trait_type":"Stabs","value":"Lost"'));
        assertFalse(LibString.contains(json, '"trait_type":"Colour"')); // (carved: the face's own colours)
    }

    /// Writes SVGs to ./render for tools/check-render.py: the whole and Great Pumpkin plus every 25th edition and
    /// the specials, or all 1,031 with RENDER=1.
    function test_render_editions() public {
        vm.createDir("render", true); // (not in the repo: the SVGs are generated)
        vm.writeFile("render/whole.svg", renderer.svgAt(0, 0, false));
        vm.writeFile("render/whole-lit.svg", renderer.svgAt(0, 0, true));
        vm.writeFile("render/great.svg", renderer.svgAt(3, 0, false));
        bool all = vm.envOr("RENDER", false);
        for (uint256 e = 1; e <= 1031; ++e) {
            if (!all && e % 25 != 0 && e % 100 != 31) continue;
            vm.writeFile(string.concat("render/", LibString.toString(e), ".svg"), renderer.svgAt(2, e, false));
            vm.writeFile(string.concat("render/", LibString.toString(e), "-lit.svg"), renderer.svgAt(2, e, true));
        }
    }

    function test_gas() public {
        address a = _buyer(1);
        address b = _buyer(2);
        vm.prank(a);
        uint256 g0 = gasleft();
        game.buy{value: P}(1);
        emit log_named_uint("buy 1", g0 - gasleft());
        vm.prank(b);
        g0 = gasleft();
        game.buy{value: 5 * P}(5);
        emit log_named_uint("buy 5", g0 - gasleft());
        _open();
        vm.prank(a);
        g0 = gasleft();
        game.carve(1, 2);
        emit log_named_uint("carve", g0 - gasleft());
        _next(2);
        vm.prank(b);
        g0 = gasleft();
        game.carve(3, 1); // (2's knife broke when a carved it)
        emit log_named_uint("carve + settle 1", g0 - gasleft());
        _next(2);
        g0 = gasleft();
        game.tokenURI(2);
        emit log_named_uint("tokenURI view", g0 - gasleft());
    }
}

/// EIP-2935's history contract, as a test stand-in: any block's hash, made up but fixed.
contract History {
    fallback(bytes calldata data) external returns (bytes memory) {
        return abi.encode(keccak256(abi.encode("history", abi.decode(data, (uint256)))));
    }
}

/// A wallet that refuses ETH until it's told otherwise.
contract Picky {
    CryptoPunkins game;
    bool open;

    constructor(CryptoPunkins game_) {
        game = game_;
    }

    function buy(uint256 n) external {
        game.buy{value: n * game.PRICE()}(n);
    }

    function allow() external {
        open = true;
    }

    function claim(uint256 id) external {
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        game.claim(ids);
    }

    receive() external payable {
        require(open, "no thanks");
    }
}

/// A wallet that burns every bit of gas it's sent.
contract Burner {
    CryptoPunkins game;

    constructor(CryptoPunkins game_) {
        game = game_;
    }

    function buy(uint256 n) external {
        game.buy{value: n * game.PRICE()}(n);
    }

    receive() external payable {
        uint256 i;
        while (gasleft() > 0) ++i;
    }
}

/// A wallet that tries to be paid again while it's being paid.
contract Greedy {
    CryptoPunkins game;
    uint256 public tries;

    constructor(CryptoPunkins game_) {
        game = game_;
    }

    function buy(uint256 n) external {
        game.buy{value: n * game.PRICE()}(n);
    }

    receive() external payable {
        ++tries;
        try game.sendShares(1, 3) {} catch {}
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        try game.claim(ids) {} catch {}
    }
}
