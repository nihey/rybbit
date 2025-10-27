import { FastifyReply, FastifyRequest } from "fastify";
import SqlString from "sqlstring";
import { clickhouse } from "../../db/clickhouse/clickhouse.js";
import { getIsUserAdmin } from "../../lib/auth-utils.js";
import { processResults } from "../analytics/utils.js";

type ServiceEventCountResponse = {
  event_date: string;
  pageview_count: number;
  custom_event_count: number;
  performance_count: number;
  event_count: number;
}[];

export async function getAdminServiceEventCount(
  req: FastifyRequest<{
    Querystring: {
      startDate?: string;
      endDate?: string;
      timeZone?: string;
    };
  }>,
  res: FastifyReply
) {
  const isAdmin = await getIsUserAdmin(req);

  if (!isAdmin) {
    return res.status(401).send({ error: "Unauthorized" });
  }

  const { startDate, endDate, timeZone = "UTC" } = req.query;

  try {
    // Build time filter for the query
    let timeFilter = "";
    let fillFromDate = "";
    let fillToDate = "";

    if (startDate && endDate) {
      timeFilter = `AND event_hour >= toTimeZone(
        toStartOfDay(toDateTime(${SqlString.escape(startDate)}, ${SqlString.escape(timeZone)})),
        'UTC'
      )
      AND event_hour < if(
        toDate(${SqlString.escape(endDate)}) = toDate(now(), ${SqlString.escape(timeZone)}),
        now(),
        toTimeZone(
          toStartOfDay(toDateTime(${SqlString.escape(endDate)}, ${SqlString.escape(timeZone)})) + INTERVAL 1 DAY,
          'UTC'
        )
      )`;

      // Set up WITH FILL parameters
      fillFromDate = `FROM toTimeZone(
        toStartOfDay(toDateTime(${SqlString.escape(startDate)}, ${SqlString.escape(timeZone)})),
        'UTC'
      )`;

      fillToDate = `TO if(
        toDate(${SqlString.escape(endDate)}) = toDate(now(), ${SqlString.escape(timeZone)}),
        toStartOfDay(now()) + INTERVAL 1 DAY,
        toTimeZone(
          toStartOfDay(toDateTime(${SqlString.escape(endDate)}, ${SqlString.escape(timeZone)})) + INTERVAL 1 DAY,
          'UTC'
        )
      )`;
    } else {
      // Default to last 30 days if no date range provided
      timeFilter = "AND event_hour >= toStartOfDay(now()) - INTERVAL 30 DAY";
      fillFromDate = "FROM toStartOfDay(now()) - INTERVAL 30 DAY";
      fillToDate = "TO toStartOfDay(now()) + INTERVAL 1 DAY";
    }

    const query = `
      SELECT
        toStartOfDay(timestamp) as event_date,
        countIf(type = 'pageview') as pageview_count,
        countIf(type = 'custom_event') as custom_event_count,
        countIf(type = 'performance') as performance_count,
        count() as event_count
      FROM events
      WHERE type IN ('pageview', 'custom_event', 'performance')
        ${timeFilter.replace(/event_hour/g, "timestamp")}
      GROUP BY event_date
      ORDER BY event_date
      WITH FILL ${fillFromDate} ${fillToDate} STEP INTERVAL 1 DAY
    `;

    const result = await clickhouse.query({
      query,
      format: "JSONEachRow",
    });

    const data = await processResults<ServiceEventCountResponse[number]>(result);
    return res.send({ data });
  } catch (error) {
    console.error("Error fetching service event count:", error);
    return res.status(500).send({ error: "Failed to fetch service event count" });
  }
}
