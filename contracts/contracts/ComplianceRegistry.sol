// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ComplianceRegistry
/// @notice On-chain anchor for VeriLex compliance verdicts.
///         The VeriLex agent (via a Chainlink CRE workflow) periodically checks
///         that a tokenized asset's circulating supply is backed by custodian-
///         attested reserves and that its legal documentation is in force, then
///         records the verdict here so anyone can verify it trustlessly.
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
        bytes32 reportHash; // hash of the full off-chain reasoning trail (IPFS/JSON)
        address reporter; // address that submitted the report
    }

    /// @notice Address allowed to submit reports directly (demo/local use).
    address public reporter;

    /// @notice Chainlink Keystone forwarder allowed to deliver CRE reports
    ///         via onReport(). Set to the forwarder for the target chain.
    address public forwarder;

    mapping(address => Report) private _latest;
    mapping(address => Report[]) private _history;

    event ReporterUpdated(address indexed reporter);
    event ReportSubmitted(
        address indexed token,
        Status status,
        uint256 reserveRatioBps,
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

    event ForwarderUpdated(address indexed forwarder);

    function setForwarder(address forwarder_) external onlyOwner {
        require(forwarder_ != address(0), "zero forwarder");
        forwarder = forwarder_;
        emit ForwarderUpdated(forwarder_);
    }

    /// @notice Chainlink CRE entry point. The CRE workflow delivers a signed
    ///         report whose payload is abi.encode(token, reserveRatioBps,
    ///         status, reportHash). Called by the Keystone forwarder.
    /// @dev Fail-closed: until the owner configures a forwarder, onReport
    ///      rejects every caller. A compliance anchor must never accept
    ///      unauthenticated verdicts just because setup is incomplete.
    function onReport(bytes calldata /* metadata */, bytes calldata report) external {
        require(forwarder != address(0) && msg.sender == forwarder, "not forwarder");
        (address token, uint256 reserveRatioBps, Status status, bytes32 reportHash) = abi.decode(
            report,
            (address, uint256, Status, bytes32)
        );
        _record(token, reserveRatioBps, status, reportHash);
    }

    /// @notice Record a new compliance verdict for a tokenized asset.
    /// @param token          The TokenizedAsset contract address.
    /// @param reserveRatioBps Reserves divided by supply in basis points.
    /// @param status         Agent verdict.
    /// @param reportHash     Hash of the detailed off-chain report/reasoning trail.
    function submitReport(
        address token,
        uint256 reserveRatioBps,
        Status status,
        bytes32 reportHash
    ) external onlyReporter {
        _record(token, reserveRatioBps, status, reportHash);
    }

    function _record(
        address token,
        uint256 reserveRatioBps,
        Status status,
        bytes32 reportHash
    ) internal {
        require(token != address(0), "zero token");
        require(status != Status.Unknown, "unknown status");
        Report memory r = Report({
            timestamp: block.timestamp,
            reserveRatioBps: reserveRatioBps,
            status: status,
            reportHash: reportHash,
            reporter: msg.sender
        });
        _latest[token] = r;
        _history[token].push(r);
        emit ReportSubmitted(token, status, reserveRatioBps, reportHash, block.timestamp);
    }

    function latestReport(address token) external view returns (Report memory) {
        return _latest[token];
    }

    function reportCount(address token) external view returns (uint256) {
        return _history[token].length;
    }

    function reportAt(address token, uint256 index) external view returns (Report memory) {
        return _history[token][index];
    }
}
