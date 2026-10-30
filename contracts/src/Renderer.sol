// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SSTORE2} from "solady/utils/SSTORE2.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";
import {DynamicBufferLib} from "solady/utils/DynamicBufferLib.sol";
import {LibBytes} from "solady/utils/LibBytes.sol";

/// @notice Draws CryptoPunkins from the 2021 layers, all stored onchain. Packed by tools/pack.py:
/// art      palette (rgba), layer table, row runs (y, x, len, colour) on a 38x38 cell grid; the last three layers
///          are the whole pumpkin, the whole pumpkin on Halloween and the Great Pumpkin. Then the colours: how
///          many besides orange, and every palette colour (rgb) in each of them
/// traits   category names, value names, the layer each value draws and its Halloween glow layer (255 none)
/// editions 8 bytes per edition (a value per category, 0 = none)
/// An uncut pumpkin comes in one of five oranges, set by its id, so its colour is known (and real) from the mint.
/// Every Oct 31 (New York time) the pumpkins dim and their carved holes glow, forever.
contract Renderer {
    using DynamicBufferLib for DynamicBufferLib.DynamicBuffer;

    uint256 public constant EDITIONS = 1031;

    // how a pumpkin looks, set by the game
    uint256 public constant WHOLE = 0;
    uint256 public constant CARVING = 1;
    uint256 public constant CARVED = 2;
    uint256 public constant GREAT = 3;
    /// on Halloween every layer but the night scene is drawn at this percent, so the glowing holes carry
    uint256 public constant DIM = 62;

    /// the art runs past one contract's 24,575 bytes, so it's stored in two halves
    address public immutable art;
    address public immutable art2;
    address public immutable traits;
    address public immutable editions;

    string internal constant DESCRIPTION =
        "1,031 pumpkins, fully onchain. Every one comes with two stabs for carving anyone else's from 8 PM on Halloween "
        "(or your own, any time, to see its face), and they're lost if their own pumpkin is carved first. 90% of every "
        "mint goes in the pot, and the pumpkins still whole at midnight become Great Pumpkins and split it. Every Oct "
        "31, they light up.";

    /// `editions_` is already stored (SSTORE2), written just before this: with it in here too, deploying the
    /// renderer would run past Ethereum's 48KB limit on what a deploy can carry.
    constructor(bytes memory art_, bytes memory traits_, address editions_) {
        require(editions_.code.length == EDITIONS * 8 + 1, "editions"); // (SSTORE2 data starts one byte in)
        uint256 half = art_.length / 2;
        art = SSTORE2.write(LibBytes.slice(art_, 0, half));
        art2 = SSTORE2.write(LibBytes.slice(art_, half));
        traits = SSTORE2.write(traits_);
        editions = editions_;
    }

    /// @notice The edition behind sale slot `i` (0..1030): every 2021 number is in the pool.
    function poolEdition(uint256 i) external pure returns (uint256) {
        return i + 1;
    }

    /// @notice An uncut pumpkin's colour, 0..4 (Orange, Rust, Amber, Copper, Gold), set by its id.
    function colourOf(uint256 id) public pure returns (uint256) {
        return uint256(uint32(id * 2654435761)) % 5;
    }

    /// @notice The 8 trait values of an edition (1..1031), each 1-based within its category, 0 for none.
    function editionTraits(uint256 edition) public view returns (bytes memory) {
        require(edition >= 1 && edition <= EDITIONS, "edition");
        return SSTORE2.read(editions, (edition - 1) * 8, edition * 8);
    }

    function tokenURI(
        uint256 id,
        uint256 look,
        uint256 edition,
        address carver,
        uint256 knives,
        bool broken,
        uint256 cut1,
        uint256 cut2,
        uint256 pot
    ) external view returns (string memory) {
        DynamicBufferLib.DynamicBuffer memory j;
        j.p('{"name":"', bytes(_name(id, look, edition)), '","description":"', bytes(DESCRIPTION), '","image":"');
        uint256 colour = look == CARVED || look == GREAT ? 0 : colourOf(id);
        j.p("data:image/svg+xml;base64,", bytes(Base64.encode(bytes(svgIn(look, edition, isHalloween(block.timestamp), colour)))), '","attributes":[');
        if (look == CARVED) {
            bytes memory t = SSTORE2.read(traits);
            bytes memory v = editionTraits(edition);
            (uint256 pos, uint256 cats) = (1, uint8(t[0]));
            for (uint256 c; c < cats; ++c) {
                (bytes memory cat, uint256 next) = _str(t, pos);
                uint256 n = uint8(t[next]);
                pos = next + 1;
                uint256 pick = uint8(v[c]);
                for (uint256 k; k < n; ++k) {
                    (bytes memory val, uint256 after_) = _str(t, pos);
                    if (k + 1 == pick) j.p('{"trait_type":"', cat, '","value":"', val, '"},');
                    pos = after_ + 2; // skip the layer and glow bytes
                }
            }
            j.p('{"trait_type":"Carved by","value":"', bytes(LibString.toHexStringChecksummed(carver)), '"},');
        } else {
            j.p('{"trait_type":"State","value":"', bytes(look == GREAT ? "Great Pumpkin" : look == CARVING ? "Carving" : "Whole"), '"},');
            if (look != GREAT) j.p('{"trait_type":"Colour","value":"', bytes(_colourName(colour)), '"},');
        }
        bytes memory left = broken ? bytes("Lost") : bytes(LibString.toString(knives));
        j.p('{"trait_type":"Stabs","value":"', left, '"}');
        if (cut1 != 0) {
            bytes memory cuts = abi.encodePacked("#", LibString.toString(cut1));
            if (cut2 != 0) cuts = abi.encodePacked(cuts, " and #", LibString.toString(cut2));
            j.p(',{"trait_type":"Carved","value":"', cuts, '"}');
        }
        // after midnight, whether its share of the pot has gone out, so nobody buys one thinking the share comes with it
        if (pot != 0) j.p(',{"trait_type":"Pot share","value":"', bytes(pot == 2 ? "Paid" : "Unpaid"), '"}');
        j.p("]}");
        return string.concat("data:application/json;base64,", Base64.encode(j.data));
    }

    function contractURI() external view returns (string memory) {
        string memory json = string.concat(
            '{"name":"CryptoPunkins","description":"', DESCRIPTION, '","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg(GREAT, 0))), '","external_link":"https://taylor.fyi/cryptopunkins"}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// @notice Oct 31 in New York (always daylight time then, UTC-4), any year.
    function isHalloween(uint256 ts) public pure returns (bool) {
        // days to civil date (Howard Hinnant's algorithm)
        uint256 z = (ts - 4 hours) / 1 days + 719468;
        uint256 doe = z % 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 day = doy - (153 * mp + 2) / 5 + 1;
        uint256 month = mp < 10 ? mp + 3 : mp - 9;
        return month == 10 && day == 31;
    }

    /// @notice The picture as it looks right now: a whole or Great Pumpkin, or the carved 2021 punkin on its night
    /// scene, lit from inside if it's Halloween.
    function svg(uint256 look, uint256 edition) public view returns (string memory) {
        return svgAt(look, edition, isHalloween(block.timestamp));
    }

    function svgAt(uint256 look, uint256 edition, bool lit) public view returns (string memory) {
        return svgIn(look, edition, lit, 0);
    }

    /// @notice The same, an uncut pumpkin in one of its colours (0..4).
    function svgIn(uint256 look, uint256 edition, bool lit, uint256 colour) public view returns (string memory) {
        bytes memory a = bytes.concat(SSTORE2.read(art), SSTORE2.read(art2));
        uint256 colours = _u16(a, 0);
        uint256 table = 2 + colours * 4;
        uint256 layers = _u16(a, table);
        uint256 runs = table + 2 + (layers + 1) * 2;
        // the colours come after the runs: palette colour k in colour c (1..4) is 3 bytes at shades + ((c-1) * colours + k) * 3
        uint256 shades = colour == 0 ? 0 : runs + _u16(a, table + 2 + layers * 2) + 1 + ((colour - 1) * colours) * 3;

        DynamicBufferLib.DynamicBuffer memory s;
        s.reserve(24_000);
        s.p('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0.25 0.5 37.5 37.5" shape-rendering="crispEdges">');
        if (look == CARVED) {
            bytes memory t = SSTORE2.read(traits);
            bytes memory v = editionTraits(edition);
            uint256 pos = 1;
            uint256 cats = uint8(t[0]);
            for (uint256 c; c < cats; ++c) {
                (, uint256 next) = _str(t, pos);
                uint256 n = uint8(t[next]);
                pos = next + 1;
                uint256 pick = uint8(v[c]);
                for (uint256 k; k < n; ++k) {
                    (, uint256 after_) = _str(t, pos);
                    if (k + 1 == pick) {
                        _layer(s, a, runs, table, uint8(t[after_]), lit && c > 0, 0);
                        uint256 glow = uint8(t[after_ + 1]);
                        if (lit && glow != 255) _layer(s, a, runs, table, glow, false, 0);
                    }
                    pos = after_ + 2;
                }
            }
        } else {
            // the last three layers: the whole pumpkin, the whole pumpkin on Halloween, the Great Pumpkin
            _layer(s, a, runs, table, look == GREAT ? layers - 1 : lit ? layers - 2 : layers - 3, false, look == GREAT ? 0 : shades);
        }
        s.p("</svg>");
        return s.s();
    }

    /// `shades`: where this pumpkin's colour starts in the colours table, or 0 for the palette as it is
    function _layer(
        DynamicBufferLib.DynamicBuffer memory s,
        bytes memory a,
        uint256 runs,
        uint256 table,
        uint256 l,
        bool dim,
        uint256 shades
    ) internal pure {
        uint256 from = runs + _u16(a, table + 2 + l * 2);
        uint256 to = runs + _u16(a, table + 4 + l * 2);
        for (uint256 i = from; i < to; i += 4) {
            uint256 k = uint8(a[i + 3]);
            uint256 c = 2 + k * 4;
            uint256 rgbAt = shades == 0 ? c : shades + k * 3;
            s.p('<rect x="', bytes(LibString.toString(uint8(a[i + 1]))), '" y="', bytes(LibString.toString(uint8(a[i]))));
            s.p('" width="', bytes(LibString.toString(uint8(a[i + 2]))), '" height="1" fill="#');
            uint256 m = dim ? DIM : 100;
            uint256 rgb = (uint256(uint8(a[rgbAt])) * m / 100) << 16 | (uint256(uint8(a[rgbAt + 1])) * m / 100) << 8
                | uint256(uint8(a[rgbAt + 2])) * m / 100;
            s.p(bytes(LibString.toHexStringNoPrefix(rgb, 3)));
            uint256 alpha = uint8(a[c + 3]);
            if (alpha < 255) s.p('" fill-opacity="', bytes(_opacity(alpha)));
            s.p('"/>');
        }
    }

    function _colourName(uint256 c) internal pure returns (string memory) {
        return c == 1 ? "Rust" : c == 2 ? "Amber" : c == 3 ? "Copper" : c == 4 ? "Gold" : "Orange";
    }

    function _name(uint256 id, uint256 look, uint256 edition) internal pure returns (string memory) {
        if (look == CARVED) return string.concat("CryptoPunkin #", LibString.toString(edition));
        if (look == GREAT) return string.concat("Great Pumpkin #", LibString.toString(id));
        return string.concat("Pumpkin #", LibString.toString(id));
    }

    /// alpha 0..255 as "0.702"
    function _opacity(uint256 alpha) internal pure returns (string memory) {
        uint256 m = (alpha * 1000 + 127) / 255;
        bytes memory d = bytes(LibString.toString(m + 1000)); // 1702 -> "702"
        return string.concat("0.", string(abi.encodePacked(d[1], d[2], d[3])));
    }

    function _u16(bytes memory b, uint256 i) internal pure returns (uint256) {
        return uint256(uint8(b[i])) << 8 | uint8(b[i + 1]);
    }

    /// a length-prefixed string at `pos`; returns it and the index after it
    function _str(bytes memory b, uint256 pos) internal pure returns (bytes memory out, uint256 next) {
        uint256 n = uint8(b[pos]);
        out = new bytes(n);
        for (uint256 i; i < n; ++i) out[i] = b[pos + 1 + i];
        next = pos + 1 + n;
    }
}
