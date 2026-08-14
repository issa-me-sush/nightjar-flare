// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title TestUSD
/// @notice A minimal, openly mintable 6-decimal stablecoin stand-in for the
/// quote side of the venue on Coston2.
///
/// Coston2 has no canonical USD₮0, and the FAssets vault-collateral `testUSD`
/// is permissioned, so demo traders cannot obtain it. This token exists purely
/// so both sides of a batch can be funded on testnet. The base asset is the
/// real FAssets FXRP. On mainnet the quote side would be USD₮0 and this
/// contract would not be deployed.
contract TestUSD {
    string public constant name = "Nightjar Test USD";
    string public constant symbol = "nUSD";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// @notice Anyone may mint. This is a testnet faucet token, not a currency.
    function mint(address _to, uint256 _amount) external {
        balanceOf[_to] += _amount;
        totalSupply += _amount;
        emit Transfer(address(0), _to, _amount);
    }

    function transfer(address _to, uint256 _amount) external returns (bool) {
        require(balanceOf[msg.sender] >= _amount, "insufficient balance");
        balanceOf[msg.sender] -= _amount;
        balanceOf[_to] += _amount;
        emit Transfer(msg.sender, _to, _amount);
        return true;
    }

    function approve(address _spender, uint256 _amount) external returns (bool) {
        allowance[msg.sender][_spender] = _amount;
        emit Approval(msg.sender, _spender, _amount);
        return true;
    }

    function transferFrom(address _from, address _to, uint256 _amount) external returns (bool) {
        uint256 allowed = allowance[_from][msg.sender];
        require(allowed >= _amount, "insufficient allowance");
        require(balanceOf[_from] >= _amount, "insufficient balance");
        if (allowed != type(uint256).max) {
            allowance[_from][msg.sender] = allowed - _amount;
        }
        balanceOf[_from] -= _amount;
        balanceOf[_to] += _amount;
        emit Transfer(_from, _to, _amount);
        return true;
    }
}
