async function fetchStitch() {
  const url = "https://stitch.withgoogle.com/preview/3072029706604223605?node-id=6afb606a8f044c1aa81686e72ca3becb&raw=1";
  const res = await fetch(url, { headers: { 'Accept': 'text/plain, application/json, */*' } });
  const text = await res.text();
  console.log("Length:", text.length);
  console.log("Content start:", text.substring(0, 500));
}
fetchStitch();
