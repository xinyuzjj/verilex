// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ComplianceRegistry
/// @notice On-chain anchor for VeriLex compliance verdicts across a whole
///         portfolio of tokenized real-world assets. The VeriLex agent (via a
///         Chainlink CRE workflow, or directly in standalone mode) evaluates
///         each asset against a versioned compliance policy and records the
///         verdict, a 0-100 compliance score and the hash of the reasoning
///         trail here, so anyone can verify the asset's compliance history
///         trustlessly. TokenizedAsset contracts can also read the latest
///         status from this registry to gate their own transfers.
contract ComplianceRegistry is Ownable {
    enum Status {
        Unknown,
        Compliant,
        AtRisk,
        Breach
    }

    struct Report {
        uint256 timestamp; // block timestamp of the check
        uint256 reserveRatioBps; // reserves / supply, in basis points (10000 = 100%)
        Status status; // agent verdict
        uint256 score; // 0-100 compliance score from the policy engine
        bytes32 reportHash; // hash of the full off-chain reasoning trail
        bytes32 policyHash; // hash of the policy version that produced the verdict
        address reporter; // address that submitted the report
    }

    /// @notice Address allowed to submit reports directly (standalone/local use).
    address public reporter;

    /// @notice Chainlink Keystone forwarder allowed to deliver CRE reports
    ///         via onReport(). Set to the forwarder for the target chain.
    address public forwarder;

    /// @notice Every token that has ever received a report, in first-seen order.
    address[] public assets;
    mapping(address => bool) private _knownAsset;

    mapping(address => Report) private _latest;
    mapping(address => Report[]) private _history;

    event ReporterUpdated(address indexed reporter);
    event ForwarderUpdated(address indexed forwarder);
    event AssetRegistered(address indexed token);
    event ReportSubmitted(
        address indexed token,
        Status status,
        uint256 reserveRatioBps,
        uint256 score,
        bytes32 reportHash,
        uint256 timestamp
    );

    constructor(address owner_) Ownable(owner_) {}

    modifier onlyReporter() {
        require(msg.sender == reporter || msg.sender == owner(), "not reporter");
        _;
    }

    function setReporter(address reporter_) external onlyOwner {
        require(reporter_ != address(0), "zero reporter");
        reporter = reporter_;
        emit ReporterUpdated(reporter_);
    }

    function setForwarder(address forwarder_) external onlyOwner {
        require(forwarder_ != address(0), "zero forwarder");
        forwarder = forwarder_;
        emit ForwarderUpdated(forwarder_);
    }

    /// @notice Chainlink CRE entry point. The CRE workflow delivers a signed
    ///         report whose payload is abi.encode(token, reserveRatioBps,
    ///         status, score, reportHash, policyHash), called by the Keystone
    ///         forwarder.
    /// @dev Fail-closed: until the owner configures a forwarder, onReport
    ///      rejects every caller. A compliance anchor must never accept
    ///      unauthenticated verdicts just because setup is incomplete.
    function onReport(bytes calldata /* metadata */, bytes calldata report) external {
        require(forwarder != address(0) && msg.sender == forwarder, "not forwarder");
        (
            address token,
            uint256 reserveRatioBps,
            Status status,
            uint256 score,
            bytes32 reportHash,
            bytes32 policyHash
        ) = abi.decode(report, (address, uint256, Status, uint256, bytes32, bytes32));
        _record(token, reserveRatioBps, status, score, reportHash, policyHash);
    }

    /// @notice Record a new compliance verdict for a tokenized asset.
    function submitReport(
        address token,
        uint256 reserveRatioBps,
        Status status,
        uint256 score,
        bytes32 reportHash,
        bytes32 policyHash
    ) external onlyReporter {
        _record(token, reserveRatioBps, status, score, reportHash, policyHash);
    }

    function _record(
        address token,
        uint256 reserveRatioBps,
        Status status,
        uint256 score,
        bytes32 reportHash,
        bytes32 policyHash
    ) internal {
        require(token != address(0), "zero token");
        require(status != Status.Unknown, "unknown status");
        require(score <= 100, "score out of range");
        if (!_knownAsset[token]) {
            _knownAsset[token] = true;
            assets.push(token);
            emit AssetRegistered(token);
        }
        Report memory r = Report({
            timestamp: block.timestamp,
            reserveRatioBps: reserveRatioBps,
            status: status,
            score: score,
            reportHash: reportHash,
            policyHash: policyHash,
            reporter: msg.sender
        });
        _latest[token] = r;
        _history[token].push(r);
        emit ReportSubmitted(token, status, reserveRatioBps, score, reportHash, block.timestamp);
    }

    function latestReport(address token) external view returns (Report memory) {
        return _latest[token];
    }

    /// @notice Lightweight status read used by TokenizedAsset's compliance gate.
    function latestStatus(address token) external view returns (Status) {
        return _latest[token].status;
    }

    function reportCount(address token) external view returns (uint256) {
        return _history[token].length;
    }

    function reportAt(address token, uint256 index) external view returns (Report memory) {
        return _history[token][index];
    }

    function assetCount() external view returns (uint256) {
        return assets.length;
    }
}
