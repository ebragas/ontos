export interface ClientConfig {
  /** The product RID: the namespace of each derived RID, such as a Link Type RID. */
  readonly productRid: string;
  readonly workosClientId: string;
  /** `staging` or `production`. */
  readonly environment: string;
}
