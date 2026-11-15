/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as appRules from "../appRules.js";
import type * as billing from "../billing.js";
import type * as bootstrap from "../bootstrap.js";
import type * as devices from "../devices.js";
import type * as dictionary from "../dictionary.js";
import type * as entitlements from "../entitlements.js";
import type * as ephemeris_account from "../ephemeris/account.js";
import type * as ephemeris_billing from "../ephemeris/billing.js";
import type * as ephemeris_retention from "../ephemeris/retention.js";
import type * as ephemeris_routes from "../ephemeris/routes.js";
import type * as ephemeris_sync from "../ephemeris/sync.js";
import type * as ephemeris_tables from "../ephemeris/tables.js";
import type * as ephemeris_workspaces from "../ephemeris/workspaces.js";
import type * as ephemeris_lib_auth from "../ephemeris/lib/auth.js";
import type * as ephemeris_lib_merge from "../ephemeris/lib/merge.js";
import type * as ephemeris_lib_plans from "../ephemeris/lib/plans.js";
import type * as ephemeris_lib_stripe from "../ephemeris/lib/stripe.js";
import type * as crons from "../crons.js";
import type * as gateway from "../gateway.js";
import type * as history from "../history.js";
import type * as http from "../http.js";
import type * as inference from "../inference.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_clerkWebhook from "../lib/clerkWebhook.js";
import type * as lib_entitlements from "../lib/entitlements.js";
import type * as lib_formatGuard from "../lib/formatGuard.js";
import type * as lib_functions from "../lib/functions.js";
import type * as lib_gatewayCore from "../lib/gatewayCore.js";
import type * as lib_inference from "../lib/inference.js";
import type * as lib_limits from "../lib/limits.js";
import type * as lib_micProtocol from "../lib/micProtocol.js";
import type * as lib_micStore from "../lib/micStore.js";
import type * as lib_normalize from "../lib/normalize.js";
import type * as lib_plans from "../lib/plans.js";
import type * as lib_streak from "../lib/streak.js";
import type * as lib_stripe from "../lib/stripe.js";
import type * as lib_timelineAudio from "../lib/timelineAudio.js";
import type * as lib_upstream from "../lib/upstream.js";
import type * as lib_users from "../lib/users.js";
import type * as lib_validators from "../lib/validators.js";
import type * as lib_worker from "../lib/worker.js";
import type * as micLink from "../micLink.js";
import type * as preferences from "../preferences.js";
import type * as snippets from "../snippets.js";
import type * as stats from "../stats.js";
import type * as timeline from "../timeline.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  appRules: typeof appRules;
  billing: typeof billing;
  bootstrap: typeof bootstrap;
  devices: typeof devices;
  dictionary: typeof dictionary;
  entitlements: typeof entitlements;
  "ephemeris/account": typeof ephemeris_account;
  "ephemeris/billing": typeof ephemeris_billing;
  "ephemeris/retention": typeof ephemeris_retention;
  "ephemeris/routes": typeof ephemeris_routes;
  "ephemeris/sync": typeof ephemeris_sync;
  "ephemeris/tables": typeof ephemeris_tables;
  "ephemeris/workspaces": typeof ephemeris_workspaces;
  "ephemeris/lib/auth": typeof ephemeris_lib_auth;
  "ephemeris/lib/merge": typeof ephemeris_lib_merge;
  "ephemeris/lib/plans": typeof ephemeris_lib_plans;
  "ephemeris/lib/stripe": typeof ephemeris_lib_stripe;
  crons: typeof crons;
  gateway: typeof gateway;
  history: typeof history;
  http: typeof http;
  inference: typeof inference;
  "lib/access": typeof lib_access;
  "lib/clerkWebhook": typeof lib_clerkWebhook;
  "lib/entitlements": typeof lib_entitlements;
  "lib/formatGuard": typeof lib_formatGuard;
  "lib/functions": typeof lib_functions;
  "lib/gatewayCore": typeof lib_gatewayCore;
  "lib/inference": typeof lib_inference;
  "lib/limits": typeof lib_limits;
  "lib/micProtocol": typeof lib_micProtocol;
  "lib/micStore": typeof lib_micStore;
  "lib/normalize": typeof lib_normalize;
  "lib/plans": typeof lib_plans;
  "lib/streak": typeof lib_streak;
  "lib/stripe": typeof lib_stripe;
  "lib/timelineAudio": typeof lib_timelineAudio;
  "lib/upstream": typeof lib_upstream;
  "lib/users": typeof lib_users;
  "lib/validators": typeof lib_validators;
  "lib/worker": typeof lib_worker;
  micLink: typeof micLink;
  preferences: typeof preferences;
  snippets: typeof snippets;
  stats: typeof stats;
  timeline: typeof timeline;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
