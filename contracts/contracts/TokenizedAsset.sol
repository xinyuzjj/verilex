// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title TokenizedAsset
/// @notice Minimal ERC-20 representing a tokenized real-world asset (RWA),
///         e.g. a fractionalized commercial property or a carbon-credit pool.
///         The off-chain reserves backing this token are attested by a custodian
///         and continuously verified by the VeriLex compliance agent.
contract TokenizedAsset is ERC20, Ownable {
    /// @notice Identifier of the underlying real-world asset in the custodian's system.
    string public assetId;

    /// @notice Human readable description of the underlying asset.
    string public underlying;

    /// @notice Jurisdiction whose legal framework governs the underlying asset.
    string public jurisdiction;

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

    /// @notice Mint new tokens (e.g. after acquiring more of the underlying asset).
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Burn tokens (e.g. on redemption of the underlying asset).
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}
