// server/models/Review.model.js
const mongoose = require("mongoose");

const ReviewSchema = new mongoose.Schema(
  {
    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course",
      required: true,
    },
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    comment: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

// Ensure one review per student per course
ReviewSchema.index({ course: 1, student: 1 }, { unique: true });

module.exports = mongoose.model("Review", ReviewSchema);