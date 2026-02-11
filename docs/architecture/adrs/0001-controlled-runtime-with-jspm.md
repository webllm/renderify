# ADR-0001: Controlled Runtime with JSPM as Default Loader

## Status

Accepted

## Context

The framework needs real-time runtime rendering without mandatory rebuilds.  
At the same time, unrestricted runtime execution is unsafe for practical deployment.

## Decision

1. adopt **controlled dynamic runtime** instead of unrestricted execution
2. keep **JSPM/SystemJS** as the default runtime module substrate
3. enforce policy checks before execution
4. execute only normalized RuntimePlan IR

## Consequences

Positive:

- supports true runtime updates
- keeps loader pluggable while retaining JSPM advantages
- creates a clear security boundary

Trade-offs:

- requires policy engineering and ongoing rule maintenance
- component contracts need stricter discipline than arbitrary code execution
- some dynamic scenarios need explicit capability grants
