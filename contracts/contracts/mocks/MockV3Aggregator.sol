// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @title MockV3Aggregator
/// @notice Local stand-in for a Chainlink Data Feed, used so the FeedConsumer
///         and the demo pipeline run identically on a local chain. On Sepolia
///         the FeedConsumer is pointed at the real feed address instead.
contract MockV3Aggregator is AggregatorV3Interface {
    uint8 public immutable overrideDecimals;

    int256 private _answer;
    uint256 private _updatedAt;
    uint80 private _roundId;

    constructor(uint8 decimals_, int256 initialAnswer) {
        overrideDecimals = decimals_;
        _update(initialAnswer);
    }

    function updateAnswer(int256 answer_) external {
        _update(answer_);
    }

    function _update(int256 answer_) internal {
        _answer = answer_;
        _updatedAt = block.timestamp;
        _roundId++;
    }

    function decimals() external view override returns (uint8) {
        return overrideDecimals;
    }

    function description() external pure override returns (string memory) {
        return "MockV3Aggregator (local demo feed)";
    }

    function version() external pure override returns (uint256) {
        return 1;
    }

    function getRoundData(
        uint80 roundId_
    ) external view override returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId_, _answer, _updatedAt, _updatedAt, roundId_);
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }
}
