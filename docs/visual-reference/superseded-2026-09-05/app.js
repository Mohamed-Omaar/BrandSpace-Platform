const views = {
  home: ["Workspace", "Good morning, Mohamed"],
  calendar: ["Plan", "Content calendar"],
  posts: ["Library", "Posts"],
  composer: ["Create", "New post"],
  studio: ["Create", "Design studio"],
  features: ["Workspace", "Features"]
};

const appShell = document.getElementById("appShell");
const title = document.getElementById("pageTitle");
const eyebrow = document.getElementById("pageEyebrow");
const navItems = [...document.querySelectorAll(".nav-item[data-view-target]")];

function showView(name) {
  if (!views[name]) return;
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.dataset.view === name));
  navItems.forEach((item) => {
    const active = item.dataset.viewTarget === name;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page"); else item.removeAttribute("aria-current");
  });
  eyebrow.textContent = views[name][0];
  title.textContent = views[name][1];
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelectorAll("[data-view-target]").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.viewTarget));
});

document.getElementById("collapseSidebar").addEventListener("click", (event) => {
  const collapsed = appShell.classList.toggle("sidebar-collapsed");
  event.currentTarget.setAttribute("aria-expanded", String(!collapsed));
  event.currentTarget.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
});

const posts = {
  launch: { title: "New collection launch", caption: "A new collection, built for the pace of real life. Thoughtful details and simple choices.", channel: "Instagram", date: "12 Mar · 09:00", art: "gradient-a", words: "NEW<br/>CHAPTER" },
  story: { title: "Founder story", caption: "The choices, people and small decisions behind the brand we are building.", channel: "LinkedIn", date: "13 Mar · 13:30", art: "gradient-b", words: "BUILT<br/>WITH CARE" },
  tips: { title: "Three useful tips", caption: "Three practical ideas our customers can use today, without the noise.", channel: "Facebook", date: "14 Mar · 18:00", art: "gradient-c", words: "THREE<br/>IDEAS" },
  reel: { title: "Studio Reel", caption: "A quiet look behind the scenes: the process, the people and the details.", channel: "TikTok", date: "15 Mar · 11:00", art: "gradient-d", words: "BEHIND<br/>THE SCENES" }
};

const drawer = document.getElementById("postDrawer");
const drawerBackdrop = document.getElementById("drawerBackdrop");
function openPost(id) {
  const post = posts[id] || posts.launch;
  document.getElementById("drawerTitle").textContent = post.title;
  document.getElementById("drawerCaption").textContent = post.caption;
  document.getElementById("drawerChannel").textContent = post.channel;
  document.getElementById("drawerDate").textContent = post.date;
  const art = document.getElementById("drawerArt");
  art.className = `drawer-art ${post.art}`;
  art.querySelector("span").innerHTML = post.words;
  drawer.classList.add("open");
  drawerBackdrop.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
}
function closePost() { drawer.classList.remove("open"); drawerBackdrop.classList.remove("open"); drawer.setAttribute("aria-hidden", "true"); }
document.querySelectorAll("[data-post-id]").forEach((button) => button.addEventListener("click", () => openPost(button.dataset.postId)));
document.getElementById("closeDrawer").addEventListener("click", closePost);
drawerBackdrop.addEventListener("click", closePost);
document.getElementById("viewPost").addEventListener("click", () => { closePost(); showView("posts"); });
document.getElementById("editPost").addEventListener("click", () => { closePost(); showView("composer"); });

const copilotDrawer = document.getElementById("copilotDrawer");
const copilotBackdrop = document.getElementById("copilotBackdrop");
function openCopilot() { copilotDrawer.classList.add("open"); copilotBackdrop.classList.add("open"); copilotDrawer.setAttribute("aria-hidden", "false"); }
function closeCopilot() { copilotDrawer.classList.remove("open"); copilotBackdrop.classList.remove("open"); copilotDrawer.setAttribute("aria-hidden", "true"); }
document.getElementById("openCopilot").addEventListener("click", openCopilot);
document.getElementById("featureCopilot").addEventListener("click", openCopilot);
document.getElementById("closeCopilot").addEventListener("click", closeCopilot);
copilotBackdrop.addEventListener("click", closeCopilot);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { closePost(); closeCopilot(); }
});
