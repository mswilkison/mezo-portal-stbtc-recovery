stBTC is our prototype of "staked Bitcoin", allowing users to earn points now
via [Mezo](https://mezo.org), separate points and principal via [Pendle](https://pendle.finance), and earn real yield in the future (via
[Acre](https://acre.fi)).

# User Stories

## Mezo

### Deposits, withdrawals, & interest

- get stBTC 1:1 for tBTC / WBTC deposit
- variable interest charged against the underlying deposit
  - tBTC rate is independent from WBTC rate
- withdrawal requires entire stBTC debt to be paid

A user deposits 10 tBTC in the Mezo portal with a 9 month lockup.

- The user sees that they can mint up to 10 stBTC at a 10% annual interest rate. On mint, they receive 10 stBTC.
- After 9 months, the user wants to withdraw their tBTC. They can't because they haven't repaid their stBTC.
- They decide to repay their 10 stBTC balance. Upon depositing it, they can now withdraw their 10 tBTC — less the interest owed on 10 stBTC over 9 months, calculated roughly as 10% _ 9 / 12 _ 10 stBTC = 0.75 tBTC. They receive 9.25 tBTC.

A user deposits 100 WBTC with a 2 month lockup.

- The user sees that they can mint up to 100 stBTC at a 10% annual interest rate. They decide to mint 10 stBTC.
- After 24 months, the user wants to withdraw their wBTC. They can't because they haven't repaid their stBTC.
- They decide to repay their 10 stBTC balance. Upon depositing it, they can now withdraw their 100 wBTC — less the interest owed on 10 stBTC over 24 months, calculated roughly as 10% _ 24 / 12 _ 10 stBTC = 2 wBTC. They receive 98 WBTC.

### Interest rate changes

A user wants to mint stBTC, but they aren't sure about how interest works.

- In the UI, the users sees that interest rates are dynamic and range between 0% and 100% percent.
- On diligence of the smart contracts, the user sees that interest rates can't be raised over 100% annually.

The Mezo stBTC governance multisig notices that stBTC is trading at a significant discount to tBTC.

- They increase the interest rate for new and existing deposits, incentivizing users to buy up and pay back their stBTC.

The Mezo stBTC governance multisig that stBTC is trading at a significant premium to tBTC.

- They decrease the interest rate for new and existing deposits, incentivizing users to mint more stBTC.

### Liquidity provisioning

- Accept WBTC+tBTC/stBTC Curve LP tokens in a way that incentivizes them slightly over raw BTC

## Pendle

- get stBTC 1:1 for tBTC / WBTC deposit
- variable interest charged against the underlying deposit

## Acre

- no fungible withdrawals from stBTC until we retire the Mezo stBTC minter
