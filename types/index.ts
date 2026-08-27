export enum TokenAbility {
  None,
  Deposit,
  DepositAndLock,
}

export enum DepositState {
  Unknown,
  Initialized,
  Finalized,
}

export enum TbtcMigrationState {
  NotRequested,
  Requested,
  InProgress,
  Completed,
}
