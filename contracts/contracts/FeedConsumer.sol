// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/// @title FeedConsumer
/// @notice Minimal Chainlink Data Feeds consumer. VeriLex uses it to convert
///         custodian reserve attestations reported in a foreign currency
///         (e.g. SGD) into USD with a live, on-chain price instead of a
///         hardcoded rate. On Sepolia this points at a real Chainlink feed;
///         locally it points at MockV3Aggregator.
contract FeedConsumer {
    AggregatorV3Interface public immutable feed;

    /// @notice Maximum accepted age of a price update, in seconds.
    uint256 public immutable maxStaleness;

    constructor(address feed_, uint256 maxStaleness_) {
        require(feed_ != address(0), "zero feed");
        feed = AggregatorV3Interface(feed_);
        maxStaleness = maxStaleness_;
    }

    function decimals() external view returns (uint8) {
        return feed.decimals();
    }

    /// @notice Latest price with sanity checks: the round must be complete,
    ///         the price positive and the update fresh enough.
    function latestPrice() public view returns (int256 price, uint256 updatedAt) {
        (uint80 roundId, int256 answer, , uint256 updatedAt_, uint80 answeredInRound) = feed
            .latestRoundData();
        require(answer > 0, "non-positive price");
        require(answeredInRound >= roundId, "stale round");
        require(block.timestamp - updatedAt_ <= maxStaleness, "stale price");
        return (answer, updatedAt_);
    }

    /// @notice Convert an amount denominated in the feed's quote terms into
    ///         its base value using the latest price, returned with the
    ///         feed's decimals precision removed (whole units, floored).
    function convert(uint256 amount) external view returns (uint256) {
        (int256 price, ) = latestPrice();
        uint8 d = feed.decimals();
        return (amount * uint256(price)) / (10 ** d);
    }
}
