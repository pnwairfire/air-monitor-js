// Requires:
//  * https://uwdata.github.io/arquero/
//  * https://momentjs.com
//  * https://momentjs.com/timezone/

class Monitor {

  meta = null;
  data = null;

  constructor(
    meta = null,
    data = null
  ) {
    this.meta = meta;
    this.data = data;
  }

  // ----- Data load -------------------------------------------------------------

  /**
   * Load latest Monitor objects from USFS AirFire repositories for 'airnow',
   * 'airsis' and 'wrcc' data.
   * 
   * This function replaces the 'meta' and 'data' properties of the 
   * 'monitorObj' with the latest available data. Data are updated every few minutes.
   * @param {String} provider One of "airnow|airsis|wrcc".
   * @param {String} archiveBaseUrlBase URL for monitoring v2 data files.
   */
   async loadLatest(
    provider = null,
    archiveBaseUrl = "https://airfire-data-exports.s3.us-west-2.amazonaws.com/monitoring/v2",
  ) {
    try {
      await this.#provider_load(provider, 'latest', archiveBaseUrl);
    } catch (e) {
      console.error(e);
    }
  }

  async loadDaily(
    provider = null,
    archiveBaseUrl = "https://airfire-data-exports.s3.us-west-2.amazonaws.com/monitoring/v2",
  ) {
    try {
      await this.#provider_load(provider, 'daily', archiveBaseUrl);
    } catch (e) {
      console.error(e);
    }
  }

  async #provider_load(
    provider = null,
    timespan = 'latest',
    archiveBaseUrl = "https://airfire-data-exports.s3.us-west-2.amazonaws.com/monitoring/v2",
  ) {

    // TODO: support additional arguments
    const QC_negativeValues = "zero";
    const QC_removesuspectData = true;

    // * Load meta -----
    let url = archiveBaseUrl + "/" + timespan + "/data/" + provider + "_PM2.5_" + timespan + "_meta.csv";
    let dt = await aq.loadCSV(url);
    this.meta = this.#parseMeta(dt);

    // * Load data -----
    url = archiveBaseUrl + "/" + timespan + "/data/" + provider + "_PM2.5_" + timespan + "_data.csv";
    dt = await aq.loadCSV(url);
    this.data = this.#parseData(dt);

  }

  // ----- Monitor manipulation ------------------------------------------------

  /**
   * Combine another Monitor object with 'this' object.
   * 
   * A new Monitor object is returned containing all timeseries and metadata from
   * 'this' Monitor as well as the passed in 'monitor'. This allows for chaining to
   * combine multiple Monitor objects.
   * @param {Monitor} monitor A monitor object.
   * @returns {Monitor} A combined monitor object.
   */
  combine(monitor) {

    let meta = this.meta.concat(monitor.meta);
    let data = this.data.join(monitor.data); // automatically joins on 'datetime' as the only shared column

    // Return
    let return_monitor = new Monitor(meta, data);
    return(return_monitor);

  }

  /**
   * Subset and reorder time series within a monitor object.
   * @param {...String} ids deviceDeploymentIDs of the time series to select.
   * @returns {Monitor} A reordered (subset) of the incoming monitor object.
   */
  select(ids) {

    let meta = this.meta
      .params({ids: ids})
      .filter((d, $) => op.includes($.ids, d.deviceDeploymentID)); // arquero filter

    let data = this.data.select('datetime', ids);

    // Return
    let return_monitor = new Monitor(meta, data);
    return(return_monitor);

  }


  /**
   * Drop monitor object time series with all missing data.
   * @returns {Monitor} A subset of the incoming monitor object.
   */
  dropEmpty() {

    let validCount = function(dt) {
      // Programmatically create a values object that counts valid values
      const ids = dt.columnNames();
      let values = {}
      ids.map(id => values[id] = "d => op.valid(d['" + id + "'])");
      let new_dt = dt.rollup(values);
      return(new_dt)
    }

    // -----
    
    let meta = this.meta;
    let data = this.data;

    // Single row table with the count of valid values 
    let countObj = validCount(data).object(0);
    // {a: 4, b: 4, c: 0}

    let ids = [];
    for (const [key, value] of Object.entries(countObj)) {
      if ( value > 0 ) ids.push(key);
    }

    // Subset data and meta
    data = data.select(ids);

    meta = meta
      .params({ids: ids})
      .filter((d, $) => op.includes($.ids, d.deviceDeploymentID)); // arquero filter

    // Return
    let return_monitor = new Monitor(meta, data);
    return(return_monitor);

  }

  /**
   * Returns a modified Monitor object with the records trimmed to full
   * local time days. Any partial days are discarded.
   * @note This function requires moment.js.
   * @param {String} timezone Olsen timezone for the time series
   * @returns {Monitor} A subset of the incoming Monitor object.
   */
  trimDate(timezone) {

    // Calculate local time hours and start/end
    let localTime = this.data.array('datetime').map(o => moment.tz(o, timezone));
    let hours = localTime.map(x => x.hours());
    let start = hours[0] == 0 ? 0 : 24 - hours[0];
    let end = hours[hours.length - 1] == 23 ? hours.length - 1 : hours.length - hours[hours.length - 1] - 1;

    // https://uwdata.github.io/arquero/api/verbs#slice
    // Subset data and meta
    let data = this.data.slice(start, end);
    let meta = this.meta;

    // Return
    let return_monitor = new Monitor(meta, data);
    return(return_monitor);
    
  }

  // ----- Get single-device values --------------------------------------------

  /**
   * Returns the array of date objects that define this Monitor object's time axis.
   * @returns {...Date} Array of Date objects.
   */
  getDatetime(id) {
    return(this.data.array('datetime'));
  }
  
  /**
   * Returns an array of NowCast values derived from the time series identified by id.
   * @param {String} id deviceDeploymentID of the time series to select.
   * @returns  {...Number}
   */
  getPM25(id) {
    let pm25 = this.data
      .array(id)
      .map(x => (x === undefined || x === null || isNaN(x)) ? null : Math.round(10 * x) / 10);
    return(pm25);
  }
    
  /**
   * Returns an array of NowCast values derived from the time series identified by id.
   * @param {*} id deviceDeploymentID of the time series to select.
   * @returns {...Number} Array of NowCast values.
   */
  getNowcast(id) {
    // See:  https://observablehq.com/@openaq/epa-pm-nowcast    
    let pm25 = this.data.array(id);
    let nowcast = Array(pm25.length);
    for (let i = 0; i < pm25.length; i++) {
      let end = i + 1;
      let start = end < 12 ? 0 : end - 12;
      nowcast[i] = this.#nowcastPM(pm25.slice(start,end));
    }
    return(nowcast);
  }

  /**
   * Calculates daily averages for the time series identified by id after the
   * time series has been trimmed to local time day boundaries. The starting
   * hour of each local time day and the daily average PM2.5 value associated
   * with that day are returned in an object with 'datetime' and 'avg_pm25' properties.
   * @param {*} id deviceDeploymentID of the time series to select.
   * @returns {Object} Object with 'datetime' and 'pm25' arrays.
   */
  getDailyAverageObject(id) {

    let index = this.getIDs().indexOf(id);
    let timezone = this.meta.array('timezone')[index];

    // Create a new table with 24-rolling average values for this monitor
    // NOTE:  Start by trimming to full days in the local timezone
    let dt = this
      .trimDate(timezone).data
      .select(['datetime', id])
      .rename(aq.names('datetime', 'pm25'))
      .derive({ avg_24hr: aq.rolling(d => op.average(d.pm25), [-23, 0]) })

    // NOTE:  Hightcharts will error out if any values are undefined. But null is OK.
    let datetime = dt.array('datetime');
    let pm25 = dt.array('pm25').map(x => x === undefined ? null : Math.round(10 * x) / 10);
    let avg_24hr = dt.array('avg_24hr').map(x => x === undefined ? null : Math.round(10 * x) / 10);

    let dayCount = avg_24hr.length / 24;
    let time_indices = [];
    let avg_indices = [];
    for (let i = 0; i < dayCount; i++) { 
      time_indices[i] = 24 * i;     // avg assigned to beginning of day
      avg_indices[i] = 24 * i + 23; // avg calculated at end of day
    }

    let daily_datetime = time_indices.map(x => datetime[x]);
    let daily_pm25 = avg_indices.map(x => avg_24hr[x]);

    return({datetime: daily_datetime, avg_pm25: daily_pm25});

  }

  /**
   * Returns the named metadata field for the time series identified by id.
   * @param {*} id deviceDeploymentID of the time series to select.
   * @returns {Object} Object with 'datetime' and 'pm25' arrays.
   */
  getMetadata(id, fieldName) {
    const index = this.getIDs().indexOf(id);
    return(this.meta.array(fieldName)[index]);
  }

 // ----- Utility methods -----------------------------------------------------

  /**
   * Returns an array of unique identifiers (deviceDeploymentIDs) found in a Monitor object
   * @returns {...String} An array of deviceDeploymentIDs.
   */
   getIDs() {
    return(this.meta.array('deviceDeploymentID'));
  }

  /**
   * Returns the number of individual time series found in a Monitor object
   * @returns {Int} Count of individual time series.
   */
   count() {
    return(this.meta.numRows());
  }

  // ----- Special methods------------------------------------------------------

  /**
   * Augment monitor.meta with current status information derived from monitor.data
   * @param {Monitor} monitor Monitor object with 'meta' and 'data'.
   * @returns {Table} An enhanced version of monitor.meta.
   */
  getCurrentStatus() {

    let data = this.data;

    let ids = this.getIDs();

    // Create a data table with no 'datetime' but an added 'index' column
    // NOTE:  op.row_number() starts at 1
    let dataBrick = data.select(aq.not('datetime')).derive({index: d => op.row_number() - 1});

    // Programmatically create a values object that replaces valid values with a row index
    let values1 = {}
    ids.map(id => values1[id] = "d => op.is_finite(d['" + id + "']) ? d.index : 0");

    // Programmatically create a values object that finds the max for each columnm
    let values2 = {}
    ids.map(id => values2[id] = "d => op.max(d['" + id + "'])");

    // Create a single-row dt with the row index of the last valid PM2.5 value
    // Then extract the row as a an object with deviceID: index
    let lastValidIndexObj = dataBrick.derive(values1).rollup(values2).object(0);

    // Array of indices;
    let lastValidIndex = Object.values(lastValidIndexObj);

    // Map indices onto an array of datetimes
    let lastValidDatetime = lastValidIndex.map(index => data.array('datetime')[index]);

    // Map ids onto an array of PM2.5 values
    let lastValidPM_25 = ids.map((id, index) => data.get(id, lastValidIndex[index]));

    // Create a data table with current status columns
    let lastValidDT = aq.table({
      lastValidDatetime: lastValidDatetime,
      lastValidPM_25: lastValidPM_25
    })

    // Return the enhanced metadata  
    let metaPlus = this.meta.assign(lastValidDT)

    return(metaPlus)

  }

  createGeoJSON() {

    // From:  mv4_wrcc_PM2.5_latest.geojson
    //
    // {
    //   "type": "FeatureCollection",
    //   "features": [
    //     {
    //       "type": "Feature",
    //       "geometry": {
    //         "type": "Point",
    //         "coordinates": [-114.0909, 46.5135]
    //       },
    //       "properties": {
    //         "deviceDeploymentID": "aaef057f3e4d83c4_wrcc.s139",
    //         "locationName": "Smoke USFS R1-39",
    //         "timezone": "America/Denver",
    //         "dataIngestSource": "WRCC",
    //         "dataIngestUnitID": "s139",
    //         "currentStatus_processingTime": "2022-12-12 13:54:13",
    //         "last_validTime": "2022-12-12 12:00:00",
    //         "last_validLocalTimestamp": "2022-12-12 05:00:00 MST",
    //         "last_nowcast": "2.9",
    //         "last_PM2.5": "2",
    //         "last_latency": "1",
    //         "yesterday_PM2.5_avg": "4.7"
    //       }
    //     }
    //   ]
    // }

    let meta = this.getCurrentStatus();
    let features = Array(this.meta.numRows());

    for (let i = 0; i < this.meta.numRows(); i++) {
      let site = meta.slice(i,i+1).object();
      features[i] = {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [site.longitude, site.latitude]
        },
        properties: {
          deviceDeploymentID: site.deviceDeploymentID,
          locationName: site.locationName,
          last_time: site.lastValidDatetime,
          last_pm25: site.lastValidPM_25
        }
      }
    }

    let geojsonObj = {
      type: "FeatureCollection",
      features: features
    }

    return(geojsonObj);

  }


  // ----- Constants -----------------------------------------------------------

  coreMetadataNames = [
    "deviceDeploymentID",
    "deviceID",
    "deviceType",
    "deviceDescription",
    "pollutant",         
    "units",
    "dataIngestSource",
    "locationID",
    "locationName",
    "longitude",
    "latitude",
    "elevation",
    "countryCode",         
    "stateCode",
    "countyName",
    "timezone",
    "AQSID",
    "fullAQSID", 
  ];

  // ----- Private methods -----------------------------------------------------

  /**
   * Automatic parsing works quite well. We help out with:
   *   1. replace 'NA' with null
   *   2. only retain core metadata columns
   */
  #parseMeta(dt) {
    // Programmatically create a values object that replaces values. See:
    //   https://uwdata.github.io/arquero/api/expressions

    const ids = dt.columnNames();

    // Replace 'NA' with null
    let values1 = {};
    ids.map(id => values1[id] = "d => d['" + id + "'] === 'NA' ? null : d['" + id + "']");
    
    // Guarantee numeric
    let values2 = {
      longitude: d => op.parse_float(d.longitude),
      latitude: d => op.parse_float(d.latitude),
      elevation: d => op.parse_float(d.elevation)
    }
    return(dt.derive(values1).derive(values2).select(this.coreMetadataNames));
  }

  /** 
   * Automatic parsing doesn't automatically recognize 'NA' as null so data gets
   * parsed as text strings. We fix things by:
   *   1. replace 'NA' with null and convert to numeric
   *   2. lift any negative values to zero (matching the default R code behavior)
   */
  #parseData(dt) {
    // Programmatically create a values object that replaces values. See:
    //   https://uwdata.github.io/arquero/api/expressions

    const ids = dt.columnNames().splice(1);  // remove 'datetime'

    // Replace 'NA' with null
    let values1 = {};
    ids.map(id => values1[id] = "d => d['" + id + "'] === 'NA' ? null : op.parse_float(d['" + id + "'])");

    // Lift up negative values to zero
    // NOTE:  'null <= 0' evaluates to true. So we have to test with '< 0'.
    let values2 = {};
    ids.map(id => values2[id] = "d => d['" + id + "'] < 0 ? 0 : d['" + id + "']");

    // Return the modified data table
    return(dt.derive(values1).derive(values2));
  }

  // ---------------------------------------------------------------------------
  // ----- Nowcast function from https://observablehq.com/@openaq/epa-pm-nowcast
  // ---------------------------------------------------------------------------

  /**
   * Convert an array of up to 12 PM2.5 concentrations in chronological order
   * into a single NowCast value.
   * @param {...Number} x Array of 12 values in chronological order.
   * @returns {Number} NowCast value.
   */
  #nowcastPM(x) {

    // NOTE:  We don't insist on 12 hours of data. Convert single values into arrays.
    if (typeof(x) === 'number') x = [x];

    // NOTE:  map/reduce syntax: a: accumulator; o: object; i: index

    // NOTE:  The algorithm below assumes reverse chronological order.
    // NOTE:  WARNING:  In javascript `null * 1 = 0` which messes up things in
    // NOTE:  our mapping functions. So we convert all null to NaN
    // NOTE:  and then back to null upon return.
    x = x.reverse().map(o => o === null ? NaN : o);

    // Check for recent values;
    let recentValidCount = x.slice(0,3).reduce((a,o) => (Number.isNaN(o) ? a : a + 1), 0);
    if ( recentValidCount < 2 ) return(null);

    let validIndices = x.reduce((a,o,i) => (Number.isNaN(o) ? a : a.concat(i)), []); 

    // NOTE:  max and min calculations need to be tolerant of missing values
    let max = x.filter(o => !Number.isNaN(o)).reduce((a,o) => o > a ? o : a);
    let min = x.filter(o => !Number.isNaN(o)).reduce((a,o) => o < a ? o : a);
    let scaledRateOfChange = (max - min) / max;
    let weightFactor = 1 - scaledRateOfChange < 0.5 ? 0.5 : 1 - scaledRateOfChange;

    // TODO:  Check for any valid values before attempting to reduce.
    // TODO:  If all NaN, then simple return null.

    let weightedValues = x
      .map((o,i) => o * Math.pow(weightFactor,i)) // maps onto an array including NaN
      .filter(x => !Number.isNaN(x))              // remove NaN before calculating sum

    let weightedSum = null;
    if (weightedValues.length == 0) {
      return(null);
    } else {
      weightedSum = weightedValues.reduce((a,o) => a + o); 
    }

    let weightFactorSum = validIndices
      .map(o => Math.pow(weightFactor, o))
      .reduce((a,o) => a + o);
    
    let returnVal = parseFloat((weightedSum / weightFactorSum).toFixed(1));

    // Convert NaN back to null for Highcharts
    returnVal = Number.isNaN(returnVal) ? null : returnVal;
    return(returnVal);

  }


}
