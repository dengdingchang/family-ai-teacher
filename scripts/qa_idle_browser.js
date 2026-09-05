async (page) => {
  await page.waitForFunction(() => {
    const video = document.querySelector('#avatarIdle');
    return video && video.readyState >= 2 && !video.hidden && !video.paused;
  }, null, {timeout: 12000});
  const first = await page.locator('#avatarIdle').evaluate(video => ({
    time: video.currentTime, duration: video.duration, muted: video.muted,
    width: video.videoWidth, height: video.videoHeight,
    src: new URL(video.currentSrc).pathname, hidden: video.hidden,
  }));
  await page.waitForTimeout(400);
  const second = await page.locator('#avatarIdle').evaluate(video => ({time: video.currentTime, paused: video.paused}));
  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.waitForTimeout(100);
  const reduced = await page.locator('#avatarIdle').evaluate(video => ({time: video.currentTime, paused: video.paused}));
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await page.waitForTimeout(100);
  const resumed = await page.locator('#avatarIdle').evaluate(video => ({hidden: video.hidden, paused: video.paused}));
  await page.locator('#avatarStage').screenshot({path: 'output/playwright/idle-stage.png'});
  return {
    status: first.muted && first.width === 512 && first.height === 512 &&
      first.src === '/api/avatar/idle' && second.time !== first.time &&
      reduced.paused && reduced.time < .1 && !resumed.paused && !resumed.hidden ? 'PASS' : 'FAIL',
    first, second, reduced, resumed,
    boundary: 'Browser video rendering and reduced-motion behavior, no physical media capture',
  };
}
