// Canned formulas for the mock provider. These let the harness run green
// end-to-end with no Ollama: a known-GOOD aggregate and regression formula, and
// a deliberately-BAD legend fragment (a bare `option = {…}`) so the report shows
// a realistic pass/fail mix instead of all-green.
//
// The formulas follow the real sandbox contract (return `{ html, data, reset }`,
// init the chart inside requestAnimationFrame, derive series from `data`).

/** Sum Deaths per Year, render a line chart, return the per-year series in data. */
export const GOOD_AGGREGATE = `
try {
  const yearCol = 'Year', valCol = 'Deaths';
  const byYear = {};
  for (const row of data) {
    const y = String(row[yearCol]);
    byYear[y] = (byYear[y] ?? 0) + (parseNum(row[valCol]) || 0);
  }
  const years = Object.keys(byYear).sort((a, b) => Number(a) - Number(b));
  const values = years.map(y => byYear[y]);
  const chartId = 'chart-' + Date.now();
  const isDark = document.documentElement.classList.contains('dark');
  const html = '<div class="p-3 rounded-lg bg-white dark:bg-gray-800"><p class="text-sm font-semibold mb-2">Morts par année</p><div id="' + chartId + '" style="height:260px"></div></div>';
  requestAnimationFrame(() => {
    const el = document.getElementById(chartId);
    if (!el) return;
    const chart = echarts.init(el, isDark ? 'dark' : null);
    chart.setOption({
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: years },
      yAxis: { type: 'value' },
      series: [{ name: 'Morts', type: 'line', data: values }]
    });
  });
  return { html, data: { years, values }, reset: () => { echarts.getInstanceByDom(document.getElementById(chartId))?.dispose(); } };
} catch (error) {
  return { html: '<div class="p-3 bg-red-50 text-red-700 rounded text-sm">' + error.message + '</div>', data: null, reset: () => {} };
}
`.trim()

/** Aggregate by year + a least-squares polynomial (degree-2) trend line. */
export const GOOD_REGRESSION = `
try {
  const yearCol = 'Year', valCol = 'Deaths';
  const byYear = {};
  for (const row of data) {
    const y = Number(row[yearCol]);
    if (!Number.isFinite(y)) continue;
    byYear[y] = (byYear[y] ?? 0) + (parseNum(row[valCol]) || 0);
  }
  const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
  const values = years.map(y => byYear[y]);
  // Fit a degree-2 polynomial via mathjs (normal equations), centred to keep it stable.
  const x0 = years[0];
  const xs = years.map(y => y - x0);
  const n = xs.length;
  // Build Vandermonde [1, x, x^2] and solve least squares with mathjs.
  const A = xs.map(x => [1, x, x * x]);
  const At = math.transpose(A);
  const coeffs = math.lusolve(math.multiply(At, A), math.multiply(At, values));
  const c = coeffs.map(r => Array.isArray(r) ? r[0] : r);
  const fit = xs.map(x => c[0] + c[1] * x + c[2] * x * x);
  const chartId = 'chart-' + Date.now();
  const isDark = document.documentElement.classList.contains('dark');
  const html = '<div class="p-3 rounded-lg bg-white dark:bg-gray-800"><p class="text-sm font-semibold mb-2">Morts par année + tendance</p><div id="' + chartId + '" style="height:260px"></div></div>';
  requestAnimationFrame(() => {
    const el = document.getElementById(chartId);
    if (!el) return;
    const chart = echarts.init(el, isDark ? 'dark' : null);
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['Morts', 'Tendance'] },
      xAxis: { type: 'category', data: years },
      yAxis: { type: 'value' },
      series: [
        { name: 'Morts', type: 'line', data: values },
        { name: 'Tendance', type: 'line', smooth: true, data: fit }
      ]
    });
  });
  return { html, data: { years, values, fit }, reset: () => { echarts.getInstanceByDom(document.getElementById(chartId))?.dispose(); } };
} catch (error) {
  return { html: '<div class="p-3 bg-red-50 text-red-700 rounded text-sm">' + error.message + '</div>', data: null, reset: () => {} };
}
`.trim()

/**
 * The classic small-model follow-up failure: a bare `option = {…}` fragment that
 * references `chart` from a prior turn that no longer exists. Run as a fresh
 * formula body it throws `chart is not defined` at `chart.setOption(option)`, so
 * exec.ok is false — exactly the failure the Refinement task is meant to catch.
 */
export const BAD_LEGEND_FRAGMENT = `
// ... existing code ...
option = {
  legend: { show: true, data: ['Morts'] }
};
chart.setOption(option);
`.trim()
