const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

// Load environment variables
require('dotenv').config();

// Bot configuration
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGODB_URI || 'mongodb+srv://room:room@room.4vris.mongodb.net/?retryWrites=true&w=majority&appName=room';
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id)) : [];
const MUST_JOIN_CHANNEL = process.env.MUST_JOIN_CHANNEL || '@jntuhupdates26';

// Available branches
const AVAILABLE_BRANCHES = ['CSE', 'ECE', 'EEE', 'MECH', 'CIVIL', 'IT', 'CSM', 'CSD', 'CSC', 'AIDS', 'AIML'];

// Validate required environment variables
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is required! Please set it in your .env file');
  process.exit(1);
}

if (ADMIN_IDS.length === 0) {
  console.warn('⚠️  No admin IDs configured. Add ADMIN_IDS to your .env file');
}

// Initialize bot and express app
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = 'uploads/';
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// MongoDB connection
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('Connected to MongoDB');
}).catch(err => {
  console.error('MongoDB connection error:', err);
});

// MongoDB Schemas
const fileSchema = new mongoose.Schema({
  fileName: String,
  filePath: String,
  fileId: String,
  subjectName: String,
  branches: [String], // Changed from single branch to array of branches
  regulation: String,
  type: { type: String, enum: ['notes', 'paper'] },
  examDate: Date, // Only for papers
  uploadDate: { type: Date, default: Date.now },
  uploadedBy: Number,
  downloads: { type: Number, default: 0 }
});

const requestSchema = new mongoose.Schema({
  userId: Number,
  username: String,
  firstName: String,
  subjectName: String,
  branch: String,
  regulation: String,
  type: String,
  description: String,
  requestDate: { type: Date, default: Date.now },
  status: { type: String, enum: ['pending', 'fulfilled', 'rejected'], default: 'pending' }
});

const userSchema = new mongoose.Schema({
  userId: Number,
  username: String,
  firstName: String,
  lastName: String,
  joinDate: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true },
  lastActive: { type: Date, default: Date.now },
  downloadCount: { type: Number, default: 0 }
});

const File = mongoose.model('File', fileSchema);
const Request = mongoose.model('Request', requestSchema);
const User = mongoose.model('User', userSchema);

// Helper functions
const isAdmin = (userId) => ADMIN_IDS.includes(userId);

const checkMembership = async (userId) => {
  try {
    const member = await bot.getChatMember(MUST_JOIN_CHANNEL, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (err) {
    return false;
  }
};

const registerUser = async (msg) => {
  const user = await User.findOne({ userId: msg.from.id });
  if (!user) {
    await new User({
      userId: msg.from.id,
      username: msg.from.username,
      firstName: msg.from.first_name,
      lastName: msg.from.last_name
    }).save();
  } else {
    // Update last active time
    await User.updateOne(
      { userId: msg.from.id },
      { lastActive: new Date() }
    );
  }
};

// User states for conversation flow
const userStates = new Map();

// Bot commands
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  await registerUser(msg);
  
  const welcomeMessage = `
🎓 Welcome to JNTUH Student Helper Bot!

I can help you with:
📚 Find Notes by Subject
📝 Find Previous Papers
📋 Request Study Materials
🔍 Search by Branch & Regulation

Use the menu below to get started!
  `;
  
  const keyboard = {
    reply_markup: {
      keyboard: [
        ['📚 Find Notes', '📝 Find Papers'],
        ['📋 Request Files', '🔍 Browse by Branch'],
        ['📊 File Status', '👥 Bot Users'],
        ['❓ Help']
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
  
  bot.sendMessage(chatId, welcomeMessage, keyboard);
});

// Main menu handlers
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;
  
  // Skip if it's a command or file
  if (text && text.startsWith('/') || msg.document || msg.photo) return;
  
  // Check if user has joined required channel
  if (!await checkMembership(userId) && !isAdmin(userId)) {
    const joinMessage = `
❌ You must join our channel first to use this bot!

👆 Click the button below to join our channel, then try again.
    `;
    
    const joinKeyboard = {
      reply_markup: {
        inline_keyboard: [[
          { text: '📢 Join Channel', url: `https://t.me/${MUST_JOIN_CHANNEL.replace('@', '')}` },
          { text: '✅ Check Membership', callback_data: 'check_membership' }
        ]]
      }
    };
    
    return bot.sendMessage(chatId, joinMessage, joinKeyboard);
  }
  
  await registerUser(msg);
  
  // Handle user states first
  if (userStates.has(chatId)) {
    const state = userStates.get(chatId);
    
    if (state.action === 'search') {
      await handleSearch(chatId, text, state.type);
      userStates.delete(chatId);
      return;
    }
    
    if (state.action === 'request') {
      await handleRequest(chatId, msg, text);
      userStates.delete(chatId);
      return;
    }
    
    if (state.action === 'upload_file') {
      await handleUploadDetails(chatId, userId, text, state);
      return;
    }
  }
  
  // Main menu options
  switch (text) {
    case '📚 Find Notes':
      showSubjectSearch(chatId, 'notes');
      break;
    case '📝 Find Papers':
      showSubjectSearch(chatId, 'paper');
      break;
    case '📋 Request Files':
      showRequestForm(chatId);
      break;
    case '🔍 Browse by Branch':
      showBranchSelection(chatId);
      break;
    case '📊 File Status':
      await showFileStatus(chatId);
      break;
    case '👥 Bot Users':
      if (isAdmin(userId)) {
        await showBotUsers(chatId);
      } else {
        await showUserStats(chatId, userId);
      }
      break;
    case '❓ Help':
      showHelp(chatId);
      break;
  }
  
  // Admin commands
  if (isAdmin(userId)) {
    if (text === '/admin') {
      showAdminPanel(chatId);
    }
  }
});

// Handle file uploads from admins
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) {
    bot.sendMessage(chatId, '❌ Only admins can upload files.');
    return;
  }
  
  const document = msg.document;
  
  // Store file info and ask for details
  userStates.set(chatId, {
    action: 'upload_file',
    fileId: document.file_id,
    fileName: document.file_name,
    step: 'subject'
  });
  
  bot.sendMessage(chatId, `
📁 File received: ${document.file_name}

Please provide the following details:

Step 1/4: Enter Subject Name
Example: Data Structures, Operating Systems
  `, { force_reply: true });
});

// Handle upload details step by step
const handleUploadDetails = async (chatId, userId, text, state) => {
  const steps = ['subject', 'branches', 'regulation', 'type'];
  const currentStepIndex = steps.indexOf(state.step);
  
  if (state.step === 'branches') {
    // Handle branch selection differently
    await handleBranchSelection(chatId, state);
    return;
  }
  
  // Store current step data
  state[state.step] = text.trim();
  
  if (currentStepIndex < steps.length - 1) {
    // Move to next step
    const nextStep = steps[currentStepIndex + 1];
    state.step = nextStep;
    userStates.set(chatId, state);
    
    let promptMessage = '';
    switch (nextStep) {
      case 'branches':
        await handleBranchSelection(chatId, state);
        return;
      case 'regulation':
        promptMessage = `
Step 3/4: Enter Regulation
Example: R18, R16, R15, R13
        `;
        break;
      case 'type':
        promptMessage = `
Step 4/4: Enter Type
Choose: notes or paper
        `;
        break;
    }
    
    bot.sendMessage(chatId, promptMessage, { force_reply: true });
  } else {
    // All details collected, save file
    await saveUploadedFile(chatId, userId, state);
    userStates.delete(chatId);
  }
};

// Handle branch selection for file upload
const handleBranchSelection = async (chatId, state) => {
  const message = `
Step 2/4: Select Branch(es)

Choose one or multiple branches for this file:
  `;
  
  // Create inline keyboard with branch options
  const branchButtons = [];
  const rows = [];
  
  // Add individual branch buttons (2 per row)
  for (let i = 0; i < AVAILABLE_BRANCHES.length; i += 2) {
    const row = [];
    row.push({ text: AVAILABLE_BRANCHES[i], callback_data: `toggle_branch_${AVAILABLE_BRANCHES[i]}` });
    if (i + 1 < AVAILABLE_BRANCHES.length) {
      row.push({ text: AVAILABLE_BRANCHES[i + 1], callback_data: `toggle_branch_${AVAILABLE_BRANCHES[i + 1]}` });
    }
    rows.push(row);
  }
  
  // Add utility buttons
  rows.push([
    { text: '✅ Select All', callback_data: 'select_all_branches' },
    { text: '❌ Clear All', callback_data: 'clear_all_branches' }
  ]);
  
  rows.push([{ text: '✅ Done', callback_data: 'confirm_branch_selection' }]);
  
  const keyboard = {
    reply_markup: {
      inline_keyboard: rows
    }
  };
  
  // Initialize selected branches array if not exists
  if (!state.selectedBranches) {
    state.selectedBranches = [];
  }
  
  userStates.set(chatId, state);
  
  bot.sendMessage(chatId, message + `\nSelected: ${state.selectedBranches.join(', ') || 'None'}`, keyboard);
};

// Save uploaded file to database
const saveUploadedFile = async (chatId, userId, state) => {
  try {
    const file = new File({
      fileName: state.fileName,
      fileId: state.fileId,
      subjectName: state.subject,
      branches: state.selectedBranches || [], // Use selected branches array
      regulation: state.regulation.toUpperCase(),
      type: state.type.toLowerCase(),
      uploadedBy: userId
    });
    
    await file.save();
    
    const successMessage = `
✅ File uploaded successfully!

📄 File: ${state.fileName}
🎓 Subject: ${state.subject}
🏢 Branches: ${state.selectedBranches.join(', ')}
📅 Regulation: ${state.regulation}
📝 Type: ${state.type}
    `;
    
    bot.sendMessage(chatId, successMessage);
    
    // Notify other admins
    ADMIN_IDS.forEach(adminId => {
      if (adminId !== userId) {
        bot.sendMessage(adminId, `📤 New file uploaded by admin:\n\n${successMessage}`);
      }
    });
    
  } catch (error) {
    bot.sendMessage(chatId, '❌ Error uploading file. Please try again.');
    console.error('Upload error:', error);
  }
};

// Handle search (updated to work with branches array)
const handleSearch = async (chatId, text, type) => {
  const files = await File.find({
    subjectName: new RegExp(text, 'i'),
    type: type
  }).limit(10);
  
  if (files.length === 0) {
    bot.sendMessage(chatId, `❌ No ${type} found for "${text}". Try requesting it using 📋 Request Files.`);
  } else {
    const message = `📚 Found ${files.length} ${type} for "${text}":`;
    bot.sendMessage(chatId, message);
    
    for (const file of files) {
      const branches = file.branches && file.branches.length > 0 
        ? file.branches.join(', ') 
        : (file.branch || 'All'); // Fallback for old single branch format
      
      const fileInfo = `
📄 ${file.fileName}
🎓 Subject: ${file.subjectName}
🏢 Branches: ${branches}
📅 Regulation: ${file.regulation}
📥 Downloads: ${file.downloads}
      `;
      
      try {
        await bot.sendDocument(chatId, file.fileId, { caption: fileInfo });
        // Increment download count
        await File.updateOne({ _id: file._id }, { $inc: { downloads: 1 } });
        await User.updateOne({ userId: chatId }, { $inc: { downloadCount: 1 } });
      } catch (error) {
        bot.sendMessage(chatId, `❌ Error sending file: ${file.fileName}`);
      }
    }
  }
};

// Handle request
const handleRequest = async (chatId, msg, text) => {
  const parts = text.split('|').map(p => p.trim());
  
  if (parts.length < 4) {
    bot.sendMessage(chatId, '❌ Invalid format. Please use: Subject | Branch | Regulation | Type | Description');
    return;
  }
  
  const request = new Request({
    userId: msg.from.id,
    username: msg.from.username,
    firstName: msg.from.first_name,
    subjectName: parts[0],
    branch: parts[1],
    regulation: parts[2],
    type: parts[3],
    description: parts[4] || ''
  });
  
  await request.save();
  
  bot.sendMessage(chatId, '✅ Your request has been submitted! Admins will review it soon.');
  
  // Notify admins
  ADMIN_IDS.forEach(adminId => {
    bot.sendMessage(adminId, `📋 New file request from @${msg.from.username}:\n\n${text}`);
  });
};

// Admin panel
const showAdminPanel = (chatId) => {
  const adminMessage = `
🔧 Admin Panel

Choose an option:
  `;
  
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📤 Upload Instructions', callback_data: 'admin_upload_help' }],
        [{ text: '📋 View Requests', callback_data: 'admin_view_requests' }],
        [{ text: '📊 Statistics', callback_data: 'admin_stats' }],
        [{ text: '👥 All Users', callback_data: 'admin_all_users' }],
        [{ text: '🗑️ Delete File', callback_data: 'admin_delete_file' }]
      ]
    }
  };
  
  bot.sendMessage(chatId, adminMessage, keyboard);
};

// Subject search
const showSubjectSearch = (chatId, type) => {
  const message = `
🔍 Search for ${type === 'notes' ? 'Notes' : 'Papers'}

Please enter the subject name:
  `;
  
  bot.sendMessage(chatId, message, { force_reply: true });
  
  // Store user state for next message
  userStates.set(chatId, { action: 'search', type });
};

// Branch selection (updated to work with branches array)
const showBranchSelection = (chatId) => {
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'CSE', callback_data: 'branch_CSE' }, { text: 'ECE', callback_data: 'branch_ECE' }],
        [{ text: 'EEE', callback_data: 'branch_EEE' }, { text: 'MECH', callback_data: 'branch_MECH' }],
        [{ text: 'CIVIL', callback_data: 'branch_CIVIL' }, { text: 'IT', callback_data: 'branch_IT' }],
        [{ text: 'CSM', callback_data: 'branch_CSM' }, { text: 'CSD', callback_data: 'branch_CSD' }],
        [{ text: 'CSC', callback_data: 'branch_CSC' }, { text: 'AIDS', callback_data: 'branch_AIDS' }],
        [{ text: 'AIML', callback_data: 'branch_AIML' }]
      ]
    }
  };
  
  bot.sendMessage(chatId, 'Select your branch:', keyboard);
};

// Request form
const showRequestForm = (chatId) => {
  const message = `
📋 Request Study Materials

Please provide the following information:
Format: Subject Name | Branch | Regulation | Type (notes/paper) | Description

Example: Data Structures | CSE | R18 | notes | Need complete notes for exam
  `;
  
  bot.sendMessage(chatId, message, { force_reply: true });
  userStates.set(chatId, { action: 'request' });
};

// Show file status
const showFileStatus = async (chatId) => {
  try {
    const totalFiles = await File.countDocuments();
    const notesCount = await File.countDocuments({ type: 'notes' });
    const papersCount = await File.countDocuments({ type: 'paper' });
    const recentFiles = await File.find().sort({ uploadDate: -1 }).limit(5);
    const topDownloads = await File.find().sort({ downloads: -1 }).limit(5);
    
    let statusMessage = `
📊 File Status Report

📚 Total Files: ${totalFiles}
📖 Notes: ${notesCount}
📝 Papers: ${papersCount}

📅 Recent Uploads:
    `;
    
    recentFiles.forEach((file, index) => {
      const branches = file.branches && file.branches.length > 0 
        ? file.branches.join(', ') 
        : (file.branch || 'All');
      statusMessage += `${index + 1}. ${file.subjectName} (${branches})\n`;
    });
    
    statusMessage += `\n🔥 Most Downloaded:\n`;
    
    topDownloads.forEach((file, index) => {
      statusMessage += `${index + 1}. ${file.subjectName} - ${file.downloads} downloads\n`;
    });
    
    bot.sendMessage(chatId, statusMessage);
  } catch (error) {
    bot.sendMessage(chatId, '❌ Error fetching file status.');
  }
};

// Show user stats
const showUserStats = async (chatId, userId) => {
  try {
    const user = await User.findOne({ userId });
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({ 
      lastActive: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } 
    });
    
    const userMessage = `
👤 Your Statistics

📥 Downloads: ${user?.downloadCount || 0}
📅 Joined: ${user?.joinDate ? user.joinDate.toDateString() : 'Unknown'}
🕒 Last Active: ${user?.lastActive ? user.lastActive.toDateString() : 'Unknown'}

🌐 Bot Statistics:
👥 Total Users: ${totalUsers}
🟢 Active Users (7 days): ${activeUsers}
    `;
    
    bot.sendMessage(chatId, userMessage);
  } catch (error) {
    bot.sendMessage(chatId, '❌ Error fetching user stats.');
  }
};

// Show all bot users (admin only)
const showBotUsers = async (chatId) => {
  try {
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({ 
      lastActive: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } 
    });
    const recentUsers = await User.find().sort({ joinDate: -1 }).limit(10);
    const topUsers = await User.find().sort({ downloadCount: -1 }).limit(10);
    
    let usersMessage = `
👥 Bot Users Report

📊 Overview:
• Total Users: ${totalUsers}
• Active Users (7 days): ${activeUsers}
• Inactive Users: ${totalUsers - activeUsers}

👆 Recent Users:
    `;
    
    recentUsers.forEach((user, index) => {
      usersMessage += `${index + 1}. @${user.username || 'Unknown'} - ${user.firstName}\n`;
    });
    
    usersMessage += `\n🔥 Top Users (Downloads):\n`;
    
    topUsers.forEach((user, index) => {
      usersMessage += `${index + 1}. @${user.username || 'Unknown'} - ${user.downloadCount} downloads\n`;
    });
    
    bot.sendMessage(chatId, usersMessage);
  } catch (error) {
    bot.sendMessage(chatId, '❌ Error fetching users data.');
  }
};

// Help
const showHelp = (chatId) => {
  const helpMessage = `
❓ How to use this bot:

📚 Find Notes: Search for study notes by subject name
📝 Find Papers: Search for previous year question papers
📋 Request Files: Request materials that aren't available
🔍 Browse by Branch: Browse materials by engineering branch
📊 File Status: View file statistics and recent uploads
👥 Bot Users: View your stats or all users (admin only)

🔍 Search Tips:
• Use exact subject names for better results
• Include regulation (R18, R16, etc.) for specific results
• Be specific in your requests

👨‍💼 Admin Features:
• Upload files by sending documents directly
• Select multiple branches for each file
• View and manage user requests
• Access detailed statistics

Need help? Contact administrators.
  `;
  
  bot.sendMessage(chatId, helpMessage);
};

// Callback query handlers
bot.on('callback_query', async (callbackQuery) => {
  const message = callbackQuery.message;
  const data = callbackQuery.data;
  const chatId = message.chat.id;
  const userId = callbackQuery.from.id;
  
  if (data === 'check_membership') {
    const isMember = await checkMembership(userId);
    if (isMember) {
      bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Membership verified!' });
      bot.sendMessage(chatId, '✅ Welcome! You can now use the bot.', {
        reply_markup: {
          keyboard: [
            ['📚 Find Notes', '📝 Find Papers'],
            ['📋 Request Files', '🔍 Browse by Branch'],
            ['📊 File Status', '👥 Bot Users'],
            ['❓ Help']
          ],
          resize_keyboard: true
        }
      });
    } else {
      bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Please join the channel first!' });
    }
  }
  
  // Handle branch selection for file upload
  if (data.startsWith('toggle_branch_')) {
    const branch = data.replace('toggle_branch_', '');
    const state = userStates.get(chatId);
    
    if (state && state.action === 'upload_file' && state.step === 'branches') {
      if (!state.selectedBranches) {
        state.selectedBranches = [];
      }
      
      const index = state.selectedBranches.indexOf(branch);
      if (index > -1) {
        // Remove branch if already selected
        state.selectedBranches.splice(index, 1);
        bot.answerCallbackQuery(callbackQuery.id, { text: `❌ Removed ${branch}` });
      } else {
        // Add branch if not selected
        state.selectedBranches.push(branch);
        bot.answerCallbackQuery(callbackQuery.id, { text: `✅ Added ${branch}` });
      }
      
      userStates.set(chatId, state);
      
      // Update the message to show current selection
      const updatedText = `Step 2/4: Select Branch(es)\n\nChoose one or multiple branches for this file:\n\nSelected: ${state.selectedBranches.join(', ') || 'None'}`;
      
      try {
        bot.editMessageText(updatedText, {
          chat_id: chatId,
          message_id: message.message_id,
          reply_markup: message.reply_markup
        });
      } catch (error) {
        // Handle edit message error
      }
    }
  }
  
  if (data === 'select_all_branches') {
    const state = userStates.get(chatId);
    if (state && state.action === 'upload_file' && state.step === 'branches') {
      state.selectedBranches = [...AVAILABLE_BRANCHES];
      userStates.set(chatId, state);
      
      bot.answerCallbackQuery(callbackQuery.id, { text: '✅ All branches selected!' });
      
      const updatedText = `Step 2/4: Select Branch(es)\n\nChoose one or multiple branches for this file:\n\nSelected: ${state.selectedBranches.join(', ')}`;
      
      try {
        bot.editMessageText(updatedText, {
          chat_id: chatId,
          message_id: message.message_id,
          reply_markup: message.reply_markup
        });
      } catch (error) {
        // Handle edit message error
      }
    }
  }
  
  if (data === 'clear_all_branches') {
    const state = userStates.get(chatId);
    if (state && state.action === 'upload_file' && state.step === 'branches') {
      state.selectedBranches = [];
      userStates.set(chatId, state);
      
      bot.answerCallbackQuery(callbackQuery.id, { text: '❌ All branches cleared!' });
      
      const updatedText = `Step 2/4: Select Branch(es)\n\nChoose one or multiple branches for this file:\n\nSelected: None`;
      
      try {
        bot.editMessageText(updatedText, {
          chat_id: chatId,
          message_id: message.message_id,
          reply_markup: message.reply_markup
        });
      } catch (error) {
        // Handle edit message error
      }
    }
  }
  
  if (data === 'confirm_branch_selection') {
    const state = userStates.get(chatId);
    if (state && state.action === 'upload_file' && state.step === 'branches') {
      if (!state.selectedBranches || state.selectedBranches.length === 0) {
        bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Please select at least one branch!' });
        return;
      }
      
      bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Branch selection confirmed!' });
      
      // Move to next step
      state.step = 'regulation';
      userStates.set(chatId, state);
      
      bot.sendMessage(chatId, `
✅ Selected branches: ${state.selectedBranches.join(', ')}

Step 3/4: Enter Regulation
Example: R18, R16, R15, R13
      `, { force_reply: true });
    }
  }
  
  // Handle branch browsing (updated to work with branches array)
  if (data.startsWith('branch_')) {
    const branch = data.replace('branch_', '');
    const files = await File.find({ 
      $or: [
        { branches: branch }, // New format with branches array
        { branch: branch }    // Old format with single branch (backward compatibility)
      ]
    }).limit(20);
    
    if (files.length === 0) {
      bot.sendMessage(chatId, `❌ No files found for ${branch} branch.`);
    } else {
      bot.sendMessage(chatId, `📚 Files for ${branch} branch:`);
      for (const file of files) {
        const branches = file.branches && file.branches.length > 0 
          ? file.branches.join(', ') 
          : (file.branch || 'All');
        const info = `📄 ${file.fileName}\n🎓 ${file.subjectName}\n🏢 ${branches}\n📅 ${file.regulation}`;
        try {
          await bot.sendDocument(chatId, file.fileId, { caption: info });
          await File.updateOne({ _id: file._id }, { $inc: { downloads: 1 } });
        } catch (error) {
          console.error('Error sending file:', error);
        }
      }
    }
  }
  
  // Admin callbacks
  if (isAdmin(userId)) {
    if (data === 'admin_upload_help') {
      const helpText = `
📤 How to Upload Files:

1. Send any document (PDF, DOC, etc.) to this chat
2. I'll ask for details step by step:
   • Subject Name
   • Branch Selection (Multiple branches can be selected)
   • Regulation (R18, R16, etc.)
   • Type (notes or paper)

3. File will be saved and available for students

📝 New Features:
• ✅ Select multiple branches for each file
• ✅ Select All/Clear All branch options
• ✅ Interactive branch selection interface
• ✅ Files will be available to all selected branches

📝 Tips:
• Use clear, consistent naming
• Include regulation for better organization
• Papers should be named with exam year if available
• Select all relevant branches to maximize file accessibility
      `;
      bot.sendMessage(chatId, helpText);
    }
    
    if (data === 'admin_view_requests') {
      const requests = await Request.find({ status: 'pending' }).limit(10);
      if (requests.length === 0) {
        bot.sendMessage(chatId, '📋 No pending requests.');
      } else {
        let requestsText = '📋 Pending Requests:\n\n';
        requests.forEach((req, index) => {
          requestsText += `${index + 1}. @${req.username}\n`;
          requestsText += `   🎓 ${req.subjectName} | ${req.branch} | ${req.regulation}\n`;
          requestsText += `   📝 ${req.type} | ${req.description}\n\n`;
        });
        bot.sendMessage(chatId, requestsText);
      }
    }
    
    if (data === 'admin_stats') {
      const totalFiles = await File.countDocuments();
      const totalUsers = await User.countDocuments();
      const pendingRequests = await Request.countDocuments({ status: 'pending' });
      const totalDownloads = await File.aggregate([
        { $group: { _id: null, total: { $sum: '$downloads' } } }
      ]);
      
      const stats = `
📊 Admin Statistics

👥 Total Users: ${totalUsers}
📚 Total Files: ${totalFiles}
📋 Pending Requests: ${pendingRequests}
📥 Total Downloads: ${totalDownloads[0]?.total || 0}

📈 Files by Branch:
      `;
      
      // Updated branch statistics to handle both old and new format
      const branchStats = await File.aggregate([
        {
          $project: {
            allBranches: {
              $cond: {
                if: { $isArray: "$branches" },
                then: "$branches",
                else: { $cond: { if: "$branch", then: ["$branch"], else: [] } }
              }
            }
          }
        },
        { $unwind: "$allBranches" },
        { $group: { _id: "$allBranches", count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]);
      
      let finalStats = stats;
      branchStats.forEach(branch => {
        finalStats += `• ${branch._id}: ${branch.count} files\n`;
      });
      
      bot.sendMessage(chatId, finalStats);
    }
    
    if (data === 'admin_all_users') {
      await showBotUsers(chatId);
    }
  }
});

// Web interface routes (updated for multiple branches)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/files', async (req, res) => {
  try {
    const { branch, regulation, type, subject } = req.query;
    const query = {};
    
    if (branch) {
      query.$or = [
        { branches: branch }, // New format
        { branch: branch }    // Old format (backward compatibility)
      ];
    }
    if (regulation) query.regulation = regulation;
    if (type) query.type = type;
    if (subject) query.subjectName = new RegExp(subject, 'i');
    
    const files = await File.find(query).sort({ uploadDate: -1 });
    res.json(files);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const totalFiles = await File.countDocuments();
    const totalUsers = await User.countDocuments();
    
    // Updated branch statistics for API
    const branches = await File.aggregate([
      {
        $project: {
          allBranches: {
            $cond: {
              if: { $isArray: "$branches" },
              then: "$branches",
              else: { $cond: { if: "$branch", then: ["$branch"], else: [] } }
            }
          }
        }
      },
      { $unwind: "$allBranches" },
      { $group: { _id: "$allBranches", count: { $sum: 1 } } }
    ]);
    
    res.json({
      totalFiles,
      totalUsers,
      branches
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Migration endpoint for converting old single branch format to new multi-branch format
app.post('/api/migrate-branches', async (req, res) => {
  try {
    if (!isAdmin(req.body.userId)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const result = await File.updateMany(
      { branch: { $exists: true }, branches: { $exists: false } },
      [
        {
          $set: {
            branches: { $cond: { if: "$branch", then: ["$branch"], else: [] } }
          }
        }
      ]
    );
    
    res.json({ 
      message: 'Migration completed', 
      modifiedCount: result.modifiedCount 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🤖 Bot is running...`);
  console.log(`🌐 Health check available at /health`);
  console.log(`📚 Multiple branch selection feature enabled`);
});

// Error handling
bot.on('error', (error) => {
  console.error('Bot error:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});
