// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IComplianceRegistry {
    enum Status {
        Unknown,
        Compliant,
        AtRisk,
        Breach
    }

    function latestStatus(address token) external view returns (Status);
}

/// @title TokenizedAsset
/// @notice ERC-20 representing a tokenized real-world asset (RWA), e.g. a
///         fractionalized commercial property note, a carbon-credit pool or a
///         tokenized T-bill fund. The off-chain reserves backing this token
///         are attested by a custodian and continuously verified by the
///         VeriLex compliance agent.
///
/// @dev Compliance-aware transfers: when the owner wires this token to the
///      ComplianceRegistry and enables the gate, ordinary transfers are
///      blocked while the asset's latest anchored verdict is BREACH — the
///      token itself enforces its compliance state instead of relying on
///      every venue to check. Minting and burning are never gated, so the
///      issuer can always issue or redeem.
contract TokenizedAsset is ERC20, Ownable {
    /// @notice Identifier of the underlying real-world asset in the custodian's system.
    string public assetId;

    /// @notice Human readable description of the underlying asset.
    string public underlying;

    /// @notice Jurisdiction whose legal framework governs the underlying asset.
    string public jurisdiction;

    /// @notice Registry consulted by the compliance gate (zero = not wired).
    IComplianceRegistry public registry;

    /// @notice Whether the compliance gate is enforced on transfers.
    bool public gateEnabled;

    event RegistryUpdated(address indexed registry);
    event GateUpdated(bool enabled);

    constructor(
        string memory name_,
        string memory symbol_,
        string memory assetId_,
        string memory underlying_,
        string memory jurisdiction_,
        uint256 initialSupply,
        address owner_
    ) ERC20(name_, symbol_) Ownable(owner_) {
        assetId = assetId_;
        underlying = underlying_;
        jurisdiction = jurisdiction_;
        if (initialSupply > 0) {
            _mint(owner_, initialSupply);
        }
    }

    function setRegistry(address registry_) external onlyOwner {
        registry = IComplianceRegistry(registry_);
        emit RegistryUpdated(registry_);
    }

    function setGateEnabled(bool enabled) external onlyOwner {
        gateEnabled = enabled;
        emit GateUpdated(enabled);
    }

    /// @notice Mint new tokens (e.g. after acquiring more of the underlying asset).
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Burn tokens (e.g. on redemption of the underlying asset).
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    /// @dev OpenZeppelin v5 transfer hook. The gate applies to wallet-to-wallet
    ///      transfers only (from and to both non-zero); issuance and redemption
    ///      always pass.
    function _update(address from, address to, uint256 value) internal override {
        if (gateEnabled && address(registry) != address(0) && from != address(0) && to != address(0)) {
            require(
                registry.latestStatus(address(this)) != IComplianceRegistry.Status.Breach,
                "compliance freeze: asset in breach"
            );
        }
        super._update(from, to, value);
    }
}
