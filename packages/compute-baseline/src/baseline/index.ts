import assert from "node:assert";

import { Temporal } from "@js-temporal/polyfill";

import { Browser } from "../browser-compat-data/browser.js";
import { Compat, defaultCompat } from "../browser-compat-data/compat.js";
import { feature } from "../browser-compat-data/feature.js";
import { Release } from "../browser-compat-data/release.js";
import { browsers } from "./core-browser-set.js";
import { isFuture, toDateString, toHighDate } from "./date-utils.js";
import { support } from "./support.js";

interface Logger {
  debug?: typeof console.debug;
  info?: typeof console.info;
  log?: typeof console.log;
  warn?: typeof console.warn;
}

export let logger: Logger | undefined = process.env["DEBUG_COMPUTE_BASELINE"]
  ? console
  : undefined;

export function setLogger(logFacility: Logger | undefined) {
  logger = logFacility;
}

// Number of months after Baseline low that Baseline high happens. Keep in sync with definition:
// https://github.com/web-platform-dx/web-features/blob/main/docs/baseline.md#wider-support-high-status
export const BASELINE_LOW_TO_HIGH_DURATION = Temporal.Duration.from({
  months: 30,
});

type BaselineStatus = "low" | "high" | false;
type BaselineDate = string | null;

interface SupportStatus {
  compatKey?: string;
  baseline: BaselineStatus;
  baseline_low_date: BaselineDate;
  baseline_high_date: BaselineDate;
  discouraged: boolean;
  support: Map<Browser, Release | undefined>;
  toJSON: () => string;
}

/**
 * Given a set of compat keys, compute the aggregate Baseline support ("high",
 * "low" or false, dates, and releases) for those keys.
 */
export function computeBaseline(
  featureSelector: {
    compatKeys: [string, ...string[]];
    checkAncestors?: boolean;
  },
  compat: Compat = defaultCompat,
): SupportStatus {
  const { compatKeys } = featureSelector;
  const keys = featureSelector.checkAncestors
    ? compatKeys.flatMap((key) => withAncestors(key, compat))
    : compatKeys;

  const statuses = keys.map((key) => calculate(key, compat));
  const support = collateSupport(statuses.map((status) => status.support));

  const keystoneDate = findKeystoneDate(
    statuses.flatMap((s) => [...s.support.values()]),
  );
  const { baseline, baseline_low_date, baseline_high_date, discouraged } =
    keystoneDateToStatus(
      keystoneDate,
      statuses.some((s) => s.discouraged),
    );

  return {
    baseline,
    baseline_low_date,
    baseline_high_date,
    discouraged,
    support,
    toJSON: function () {
      return jsonify(this);
    },
  };
}

/**
 * Compute the Baseline support ("high", "low" or false, dates, and releases)
 * for a single compat key.
 */
function calculate(compatKey: string, compat: Compat): SupportStatus {
  const f = feature(compatKey);
  const s = support(f, browsers(compat));
  const keystoneDate = findKeystoneDate([...s.values()]);

  const { baseline, baseline_low_date, baseline_high_date, discouraged } =
    keystoneDateToStatus(keystoneDate, f.deprecated ?? false);

  return {
    compatKey,
    baseline,
    baseline_low_date,
    baseline_high_date,
    discouraged,
    support: s,
    toJSON: function () {
      return jsonify(this);
    },
  };
}

/**
 * Given a compat key, get the key and any of its ancestor features.
 *
 * For example, given the key `"html.elements.a.href"`, return
 * `["html.elements.a", "html.elements.a.href"]`.
 */
function withAncestors(compatKey: string, compat: Compat): string[] {
  const items = compatKey.split(".");
  const ancestors: string[] = [];

  let current = items.shift();
  while (items.length) {
    current = `${current}.${items.shift()}`;

    const data = compat.query(current);
    if (typeof data === "object" && data !== null && "__compat" in data) {
      ancestors.push(current);
    }
  }
  return ancestors;
}

/**
 * Collate several support summaries, taking the most-recent release for each browser across all of the summaries.
 */
function collateSupport(
  supports: Map<Browser, Release | undefined>[],
): Map<Browser, Release | undefined> {
  const collated = new Map<Browser, (Release | undefined)[]>();

  for (const support of supports) {
    for (const [browser, release] of support) {
      collated.set(browser, [...(collated.get(browser) ?? []), release]);
    }
  }

  const support: Map<Browser, Release | undefined> = new Map();
  for (const [browser, releases] of collated) {
    if (releases.includes(undefined)) {
      support.set(browser, undefined);
    } else {
      support.set(
        browser,
        releases
          .sort((r1, r2) => (r1 as Release).compare(r2 as Release))
          .at(-1),
      );
    }
  }
  return support;
}

/**
 * Given several dates, find the most-recent date and determine the
 * corresponding Baseline status and high and low dates.
 */
export function keystoneDateToStatus(
  date: Temporal.PlainDate | null,
  discouraged: boolean,
): {
  baseline: BaselineStatus;
  baseline_low_date: BaselineDate;
  baseline_high_date: BaselineDate;
  discouraged: boolean;
} {
  let baseline: BaselineStatus;
  let baseline_low_date;
  let baseline_high_date;

  if (discouraged || date === null || isFuture(date)) {
    baseline = false;
    baseline_low_date = null;
    baseline_high_date = null;
    discouraged = discouraged;
  } else {
    baseline = "low";
    baseline_low_date = toDateString(date);
    baseline_high_date = null;
    discouraged = false;
  }

  if (baseline === "low") {
    assert(date !== null);
    const possibleHighDate = toHighDate(date);
    if (isFuture(possibleHighDate)) {
      baseline_high_date = null;
    } else {
      baseline = "high";
      baseline_high_date = toDateString(possibleHighDate);
    }
  }

  return { baseline, baseline_low_date, baseline_high_date, discouraged };
}

/**
 * Given one or more releases, return the most-recent release date. If a release
 * is `undefined` or the release date is `null`, then return `null`, since the
 * feature is not Baseline and there is no keystone date.
 */
function findKeystoneDate(
  releases: (Release | undefined)[],
): Temporal.PlainDate | null {
  let latestDate = null;
  for (const release of releases) {
    if (!release?.date) {
      return null;
    }
    if (
      !latestDate ||
      Temporal.PlainDate.compare(latestDate, release.date) < 0
    ) {
      latestDate = release.date;
    }
  }
  return latestDate;
}

function jsonify(status: SupportStatus): string {
  const { baseline_low_date, baseline_high_date } = status;
  const support: Record<string, string> = {};

  for (const [browser, release] of status.support.entries()) {
    if (release !== undefined) {
      support[browser.id] = release.version;
    }
  }

  if (status.baseline === "high") {
    return JSON.stringify(
      {
        baseline: status.baseline,
        baseline_low_date,
        baseline_high_date,
        support,
      },
      undefined,
      2,
    );
  }

  if (status.baseline === "low") {
    return JSON.stringify(
      {
        baseline: status.baseline,
        baseline_low_date,
        support,
      },
      undefined,
      2,
    );
  }

  return JSON.stringify(
    {
      baseline: status.baseline,
      support,
    },
    undefined,
    2,
  );
}
