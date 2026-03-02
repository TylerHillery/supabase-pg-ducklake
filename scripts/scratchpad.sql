explain analyze SELECT count(*), sum(fare_amount), sum(tip_amount), avg(trip_distance) FROM yellow_trips_heap;
explain analyze SELECT * FROM get_my_trip_summary_ducklake();
explain analyze SELECT count(*), sum(fare_amount), sum(tip_amount), avg(trip_distance) FROM private.yellow_trips_ducklake;

-- full table no RLS:
explain analyze SELECT user_id, count(*), sum(fare_amount), sum(tip_amount), avg(trip_distance) FROM public.yellow_trips_heap GROUP BY 1;
-- Planning Time: 0.198 ms
-- Execution Time: 1669.176 ms
-- 11196995 ef17a871

explain analyze SELECT user_id, count(*), sum(fare_amount), sum(tip_amount), avg(trip_distance) FROM private.yellow_trips_ducklake GROUP BY 1;
-- Planning Time: 36.488 ms
-- Execution Time: 0.624 ms

-- RLS check
explain analyze SELECT count(*), sum(fare_amount), sum(tip_amount), avg(trip_distance) FROM public.yellow_trips_heap;
-- Planning Time: 0.363 ms
-- Execution Time: 46101.011 ms

explain analyze SELECT * FROM get_my_trip_summary_ducklake();
-- Planning Time: 0.012 ms
-- Execution Time: 133.090 ms