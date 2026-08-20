export enum StateSafetyClassification {
  /**
   * Safe to keep in volatile memory for single-node simulations. 
   * Data loss does not cause financial invariant breaches.
   */
  EPHEMERAL_SINGLE_NODE = 'EPHEMERAL_SINGLE_NODE',
  
  /**
   * Must be persisted across process restarts to prevent invariant breaches 
   * (e.g. lost exposure locks leading to duplicate execution).
   */
  PERSISTENT_REQUIRED = 'PERSISTENT_REQUIRED',
  
  /**
   * Must be backed by a distributed store (e.g. Redis) to ensure safety
   * when scaling horizontally across multiple nodes (e.g. rate limits, replay nonces).
   */
  DISTRIBUTED_REQUIRED = 'DISTRIBUTED_REQUIRED',

  /**
   * State is entirely owned by an external authority (e.g. Provider, NovaCEX DB).
   * Local state is merely a cache or mapping and requires reconciliation upon restart.
   */
  AUTHORITATIVE_EXTERNAL_STATE = 'AUTHORITATIVE_EXTERNAL_STATE'
}

export interface IStatefulComponent {
  getSafetyClassification(): StateSafetyClassification;
}
