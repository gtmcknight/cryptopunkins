// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {CryptoPunkins} from "../src/CryptoPunkins.sol";
import {Renderer} from "../src/Renderer.sol";
import {SSTORE2} from "solady/utils/SSTORE2.sol";

/// Deploys the renderer (art stored onchain) and the game. All 1,031 pumpkins are for sale; nothing is minted here.
///
///   END      carving closes and the pot goes to the Great Pumpkins (default 2026-11-01 00:00 New York); minting closes 4h before
///   PAYOUT   where the 10% cut goes (default FE35)
///   OWNER    marketplace profile owner, no powers (default FE35)
///   EXPECT   the game's expected address; the script stops if the deployer's nonce would put it elsewhere
contract Deploy is Script {
    address constant FE35 = 0xFE35e15bE885750D9b2363cbB6aBDd57AC9C4c40;

    function run() external returns (Renderer renderer, CryptoPunkins game) {
        uint256 end = vm.envOr("END", uint256(1793505600));
        address payout = vm.envOr("PAYOUT", FE35);
        address owner = vm.envOr("OWNER", FE35);
        address expect = vm.envOr("EXPECT", address(0));

        require(block.timestamp + 4 hours < end, "END is too soon: minting closes 4 hours before it (8 PM)");

        vm.startBroadcast();
        if (expect != address(0)) {
            // (the editions, then the renderer, then the game: two deploys before it)
            address next = vm.computeCreateAddress(msg.sender, vm.getNonce(msg.sender) + 2);
            require(next == expect, "deployer nonce moved: the game would not land at EXPECT");
        }
        address editions = SSTORE2.write(vm.readFileBinary("../data/editions.bin")); // (its own deploy, to fit)
        renderer = new Renderer(vm.readFileBinary("../data/art.bin"), vm.readFileBinary("../data/traits.bin"), editions);
        game = new CryptoPunkins(renderer, end, payout, owner);
        vm.stopBroadcast();

        console.log("renderer", address(renderer));
        console.log("game", address(game));
        console.log("end", end);
    }
}
