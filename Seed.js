// server/seed.js
// ─────────────────────────────────────────────────────────────────────────────
// Run this once to populate your database with test data
// Command: node seed.js   (run from inside the /server folder)
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const mongoose = require("mongoose");
const User     = require("./models/User.model");
const Course   = require("./models/Course.model");

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/lms-db";

async function seed() {
  console.log("\n🌱 Starting database seed...\n");

  await mongoose.connect(MONGO_URI);
  console.log("✅ MongoDB connected\n");

  // ── Clear old data ─────────────────────────────────────────────────────────
  await User.deleteMany({});
  await Course.deleteMany({});
  console.log("🗑️  Cleared old data\n");

  // ── Create instructor ──────────────────────────────────────────────────────
  const instructor = await User.create({
    name:     "Sarah Mitchell",
    email:    "instructor@test.com",
    password: "password123",
    role:     "instructor",
    title:    "Senior Digital Marketing Consultant",
    bio:      "15+ years in digital marketing. Helped 200+ companies grow online.",
  });
  console.log("👩‍🏫 Instructor: instructor@test.com / password123");

  // ── Create student ─────────────────────────────────────────────────────────
  const student = await User.create({
    name:     "Ahmed Khan",
    email:    "student@test.com",
    password: "password123",
    role:     "student",
  });
  console.log("🎓 Student:     student@test.com    / password123\n");

  // ── Create Course 1 ────────────────────────────────────────────────────────
  const course1 = await Course.create({
    title:       "Digital Marketing Mastery",
    description: "Master digital marketing from scratch — SEO, social media, email marketing, Google Ads, and more. Used by 40,000+ students worldwide. You will go from complete beginner to a confident digital marketer.",
    category:    "Marketing",
    price:       89.99,
    status:      "published",    // ← MUST be "published" to show on /courses
    instructor:  instructor._id,
    studentsEnrolled: 18420,
    rating:      4.9,
    revenue:     142300,
    sections: [
      {
        title: "Introduction to Digital Marketing",
        lectures: [
          { title: "Welcome to the Course",       type: "video", duration: "3:24",  free: true,  videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
          { title: "What is Digital Marketing?",  type: "video", duration: "8:15",  free: false, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
          { title: "Course Resources PDF",        type: "pdf",   duration: "",      free: true,  videoUrl: "" },
        ],
      },
      {
        title: "SEO Fundamentals",
        lectures: [
          { title: "How Search Engines Work",     type: "video", duration: "12:30", free: false, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
          { title: "Keyword Research Mastery",    type: "video", duration: "19:05", free: false, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
          { title: "On-Page SEO Techniques",      type: "video", duration: "16:22", free: false, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
        ],
      },
      {
        title: "Social Media Marketing",
        lectures: [
          { title: "Platform Strategy Overview",  type: "video", duration: "12:44", free: false, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
          { title: "Content Calendar Template",   type: "pdf",   duration: "",      free: true,  videoUrl: "" },
          { title: "Running Paid Social Ads",     type: "video", duration: "23:15", free: false, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
        ],
      },
    ],
  });

  // ── Create Course 2 ────────────────────────────────────────────────────────
  const course2 = await Course.create({
    title:       "Complete React Developer Bootcamp",
    description: "Build modern web applications with React 18, hooks, Redux Toolkit, React Router, and more. Includes 5 real-world projects you can add to your portfolio.",
    category:    "Web Development",
    price:       94.99,
    status:      "published",
    instructor:  instructor._id,
    studentsEnrolled: 23150,
    rating:      4.8,
    revenue:     198400,
    sections: [
      {
        title: "React Fundamentals",
        lectures: [
          { title: "What is React?",              type: "video", duration: "5:20",  free: true,  videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
          { title: "JSX Deep Dive",               type: "video", duration: "18:40", free: false, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
          { title: "Components & Props",          type: "video", duration: "22:10", free: false, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
          { title: "State & useState Hook",       type: "video", duration: "30:05", free: false, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
        ],
      },
      {
        title: "Advanced React Patterns",
        lectures: [
          { title: "useEffect & Side Effects",    type: "video", duration: "35:00", free: false, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
          { title: "Context API",                 type: "video", duration: "28:30", free: false, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
          { title: "Redux Toolkit",               type: "video", duration: "52:40", free: false, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
        ],
      },
      {
        title: "Real World Projects",
        lectures: [
          { title: "Build an E-commerce App",     type: "video", duration: "90:00", free: false, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
          { title: "Project Starter Files",       type: "pdf",   duration: "",      free: true,  videoUrl: "" },
        ],
      },
    ],
  });

  // ── Create Course 3 ────────────────────────────────────────────────────────
  const course3 = await Course.create({
    title:       "Google Ads Bootcamp — Zero to Hero",
    description: "Run profitable Google Ads campaigns from day one. Search, Display, Shopping, and YouTube ads covered in full with real campaign walkthroughs.",
    category:    "Paid Advertising",
    price:       79.99,
    status:      "published",
    instructor:  instructor._id,
    studentsEnrolled: 9720,
    rating:      4.7,
    revenue:     52100,
    sections: [
      {
        title: "Google Ads Fundamentals",
        lectures: [
          { title: "How Google Ads Works",        type: "video", duration: "11:20", free: true,  videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
          { title: "Account Setup Walkthrough",   type: "video", duration: "18:45", free: false, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
          { title: "Bidding Strategies",          type: "video", duration: "15:30", free: false, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
        ],
      },
      {
        title: "Search Campaigns",
        lectures: [
          { title: "Keyword Match Types",         type: "video", duration: "22:00", free: false, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
          { title: "Writing High-Converting Ads", type: "video", duration: "19:15", free: false, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
          { title: "Campaign Checklist PDF",      type: "pdf",   duration: "",      free: true,  videoUrl: "" },
        ],
      },
    ],
  });

  // ── Create Course 4 ────────────────────────────────────────────────────────
  const course4 = await Course.create({
    title:       "Node.js & Express — Backend Development",
    description: "Build scalable REST APIs with Node.js, Express, MongoDB, and JWT authentication. Perfect for frontend developers wanting to go full-stack.",
    category:    "Backend",
    price:       84.99,
    status:      "published",
    instructor:  instructor._id,
    studentsEnrolled: 14300,
    rating:      4.8,
    revenue:     89200,
    sections: [
      {
        title: "Node.js Basics",
        lectures: [
          { title: "What is Node.js?",            type: "video", duration: "8:00",  free: true,  videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
          { title: "NPM & Package Management",    type: "video", duration: "14:20", free: false, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
          { title: "The Event Loop",              type: "video", duration: "25:10", free: false, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
        ],
      },
      {
        title: "Building APIs with Express",
        lectures: [
          { title: "REST API Design Principles",  type: "video", duration: "20:00", free: false, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
          { title: "Middleware Explained",        type: "video", duration: "18:30", free: false, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
          { title: "JWT Authentication",         type: "video", duration: "35:45", free: false, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" },
          { title: "API Reference PDF",           type: "pdf",   duration: "",      free: true,  videoUrl: "" },
        ],
      },
    ],
  });

  // ── Enroll student in course1 and course2 ──────────────────────────────────
  student.enrolledCourses.push(course1._id, course2._id);
  await student.save();

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("✅ Created 4 published courses:");
  console.log("   1.", course1.title);
  console.log("   2.", course2.title);
  console.log("   3.", course3.title);
  console.log("   4.", course4.title);
  console.log("\n✅ Student enrolled in:");
  console.log("   -", course1.title);
  console.log("   -", course2.title);

  console.log("\n══════════════════════════════════════════════");
  console.log("  🎉 Database seeded successfully!\n");
  console.log("  Test accounts:");
  console.log("  Instructor: instructor@test.com / password123");
  console.log("  Student:    student@test.com    / password123");
  console.log("\n  Open your app:");
  console.log("  Courses:    http://localhost:3000/courses");
  console.log("  Login:      http://localhost:3000/auth/login");
  console.log("══════════════════════════════════════════════\n");

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch(err => {
  console.error("❌ Seed failed:", err.message);
  console.log("\nMake sure:");
  console.log("1. MongoDB is running (brew services start mongodb-community)");
  console.log("2. Your .env file has MONGO_URI set correctly");
  process.exit(1);
});
