//! Pure UTC anchored billing periods. Calendar boundaries always use the original anchor.
use chrono::{DateTime, Datelike, Duration, Months, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

pub const MAX_PERIOD: u32 = 10_000;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Recurrence {
    pub every: u32,
    pub unit: String,
    pub starts_at: String,
    pub anchor: String,
    pub ends_at: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BillingPeriod {
    pub starts_at: String,
    pub ends_at: String,
}
pub fn timestamp(value: &str) -> anyhow::Result<DateTime<Utc>> {
    let date = DateTime::parse_from_rfc3339(value)?.with_timezone(&Utc);
    anyhow::ensure!(
        (2020..=2100).contains(&date.year()) && text(date) == value,
        "canonical UTC timestamp required"
    );
    Ok(date)
}
pub fn text(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Secs, true)
}
impl Recurrence {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            (1..=1000).contains(&self.every) && self.starts_at == self.anchor,
            "invalid recurrence anchor or interval"
        );
        timestamp(&self.anchor)?;
        self.boundary(1)?;
        if let Some(end) = &self.ends_at {
            let end = timestamp(end)?;
            anyhow::ensure!(
                end > timestamp(&self.anchor)?,
                "recurrence end must follow start"
            );
            let index = self
                .index_at(end)?
                .ok_or_else(|| anyhow::anyhow!("end before start"))?;
            anyhow::ensure!(
                self.boundary(index)? == end,
                "recurrence must end on a whole period boundary"
            );
        }
        Ok(())
    }
    fn boundary(&self, index: u32) -> anyhow::Result<DateTime<Utc>> {
        anyhow::ensure!(index <= MAX_PERIOD + 1, "period limit exceeded");
        let anchor = timestamp(&self.anchor)?;
        let count = u64::from(self.every) * u64::from(index);
        let date = match self.unit.as_str() {
            "month" | "year" => {
                let months = count * if self.unit == "year" { 12 } else { 1 };
                anchor.checked_add_months(Months::new(months.try_into()?))
            }
            unit => {
                let seconds = match unit {
                    "minute" => 60,
                    "hour" => 3600,
                    "day" => 86400,
                    "week" => 604800,
                    _ => anyhow::bail!("unsupported recurrence unit"),
                };
                anchor.checked_add_signed(Duration::seconds((count * seconds).try_into()?))
            }
        }
        .ok_or_else(|| anyhow::anyhow!("recurrence date overflow"))?;
        anyhow::ensure!(
            date.year() <= 2100,
            "recurrence exceeds supported date range"
        );
        Ok(date)
    }
    pub fn period(&self, index: u32) -> anyhow::Result<BillingPeriod> {
        anyhow::ensure!(index <= MAX_PERIOD, "period limit exceeded");
        let start = self.boundary(index)?;
        let end = self.boundary(index + 1)?;
        if let Some(limit) = &self.ends_at {
            anyhow::ensure!(end <= timestamp(limit)?, "period is outside recurrence");
        }
        Ok(BillingPeriod {
            starts_at: text(start),
            ends_at: text(end),
        })
    }
    fn index_at(&self, now: DateTime<Utc>) -> anyhow::Result<Option<u32>> {
        if now < timestamp(&self.anchor)? {
            return Ok(None);
        }
        let mut low = 0;
        let mut high = MAX_PERIOD + 1;
        while low < high {
            let middle = low + (high - low).div_ceil(2);
            if self.boundary(middle).is_ok_and(|date| date <= now) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        anyhow::ensure!(low <= MAX_PERIOD, "period limit exceeded");
        Ok(Some(low))
    }
    pub fn latest_started(&self, now: DateTime<Utc>) -> anyhow::Result<u32> {
        let effective = if let Some(end) = &self.ends_at {
            now.min(timestamp(end)? - Duration::seconds(1))
        } else {
            now
        };
        Ok(self.index_at(effective)?.unwrap_or(0))
    }
    pub fn current(&self, now: DateTime<Utc>) -> anyhow::Result<Option<u32>> {
        let index = self.index_at(now)?;
        Ok(index.filter(|index| self.period(*index).is_ok()))
    }
    pub fn sdk(&self) -> anyhow::Result<paykit_lib::Recurrence> {
        self.validate()?;
        use paykit_lib::RecurrenceUnit::*;
        let unit = match self.unit.as_str() {
            "minute" => Minute,
            "hour" => Hour,
            "day" => Day,
            "week" => Week,
            "month" => Month,
            "year" => Year,
            _ => anyhow::bail!("unsupported recurrence"),
        };
        Ok(paykit_lib::Recurrence {
            every: self.every,
            unit,
            starts_at: self.starts_at.clone(),
            anchor: self.anchor.clone(),
            ends_at: self.ends_at.clone(),
        })
    }
    pub fn from_record(r: &paykit_sdk::PaymentRequestRecurrenceRecord) -> anyhow::Result<Self> {
        let value = Self {
            every: r.every,
            unit: r.unit.clone(),
            starts_at: r.starts_at.clone(),
            anchor: r.anchor.clone(),
            ends_at: r.ends_at.clone(),
        };
        value.validate()?;
        Ok(value)
    }
    pub fn index_of(&self, period: &BillingPeriod) -> anyhow::Result<u32> {
        let index = self
            .index_at(timestamp(&period.starts_at)?)?
            .ok_or_else(|| anyhow::anyhow!("period before anchor"))?;
        anyhow::ensure!(
            self.period(index)? == *period,
            "period does not match anchored schedule"
        );
        Ok(index)
    }
}
impl BillingPeriod {
    pub fn sdk(&self) -> paykit_lib::BillingPeriod {
        paykit_lib::BillingPeriod {
            starts_at: self.starts_at.clone(),
            ends_at: self.ends_at.clone(),
        }
    }
    pub fn from_record(value: &paykit_sdk::BillingPeriodRecord) -> Self {
        Self {
            starts_at: value.starts_at.clone(),
            ends_at: value.ends_at.clone(),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn schedule(anchor: &str, unit: &str) -> Recurrence {
        Recurrence {
            every: 1,
            unit: unit.into(),
            starts_at: anchor.into(),
            anchor: anchor.into(),
            ends_at: None,
        }
    }
    #[test]
    fn month_clamp_does_not_drift_after_february() {
        let r = schedule("2024-01-31T12:00:00Z", "month");
        assert_eq!(r.period(1).unwrap().starts_at, "2024-02-29T12:00:00Z");
        assert_eq!(r.period(2).unwrap().starts_at, "2024-03-31T12:00:00Z");
    }
    #[test]
    fn leap_year_anchor_is_preserved() {
        let r = schedule("2024-02-29T00:00:00Z", "year");
        assert_eq!(r.period(1).unwrap().starts_at, "2025-02-28T00:00:00Z");
        assert_eq!(r.period(4).unwrap().starts_at, "2028-02-29T00:00:00Z");
    }
    #[test]
    fn boundaries_are_exclusive_and_aligned() {
        let r = schedule("2026-01-01T00:00:00Z", "minute");
        assert_eq!(
            r.current(timestamp("2026-01-01T00:01:00Z").unwrap())
                .unwrap(),
            Some(1)
        );
        let mut p = r.period(0).unwrap();
        p.ends_at = "2026-01-01T00:00:59Z".into();
        assert!(r.index_of(&p).is_err());
    }
    #[test]
    fn partial_final_period_and_invalid_units_are_rejected() {
        let mut r = schedule("2026-01-01T00:00:00Z", "day");
        r.ends_at = Some("2026-01-02T12:00:00Z".into());
        assert!(r.validate().is_err());
        r.ends_at = Some("2026-01-03T00:00:00Z".into());
        assert!(r.validate().is_ok());
        assert!(r.period(2).is_err());
        r.unit = "second".into();
        assert!(r.validate().is_err());
    }
}
