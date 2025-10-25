'use client';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Upload, FileText, Camera, CheckCircle, AlertCircle, Clock, X } from 'lucide-react';
import Modal from '../../../components/Modal';

interface StepInfo {
  event_name: string;
  step_name: string;
  vendor_email: string;
  description: string;
  time_limit?: string;
  event_id: string;
  step_id: string;
}

export default function CompletePage() {
  const params = useParams();
  const router = useRouter();
  const [stepInfo, setStepInfo] = useState<StepInfo | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [comments, setComments] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    validateToken();
  }, [params.token]);

  const validateToken = async () => {
    try {
      const response = await fetch(`/api/complete/${params.token}`);
      const data = await response.json();
      
      if (data.valid) {
        setStepInfo(data.step_info);
      } else {
        setError(data.error || 'Invalid or expired link');
      }
    } catch (error) {
      setError('Error validating link');
    } finally {
      setLoading(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const selectedFiles = Array.from(e.target.files);
      setFiles(prev => [...prev, ...selectedFiles]);
    }
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const submitCompletion = async () => {
    if (files.length === 0 && !comments.trim()) {
      setError('Please upload files or add comments to complete this step');
      return;
    }

    if (submitted) {
      return; // Prevent multiple submissions
    }

    setSubmitting(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('comments', comments);

      files.forEach(file => {
        formData.append('files', file);
      });

      const response = await fetch(`/api/complete/${params.token}`, {
        method: 'POST',
        body: formData
      });

      const result = await response.json();

      if (result.success) {
        setSubmitted(true);
        setShowSuccessModal(true);
      } else {
        setError('Error completing step: ' + result.error);
      }
    } catch (error) {
      setError('Error submitting completion. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (error || !stepInfo) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center max-w-md mx-auto px-4">
          <AlertCircle className="h-16 w-16 text-red-500 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-gray-900 mb-4">Access Denied</h1>
          <p className="text-gray-600 mb-6">{error}</p>
          <button
            onClick={() => window.location.href = '/'}
            className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700"
          >
            Go Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-blue-50 py-8">
      <div className="max-w-2xl mx-auto px-4">
        <div className="bg-white rounded-xl shadow-lg p-8">
          {/* Header */}
          <div className="text-center mb-8">
            <CheckCircle className="h-16 w-16 text-green-500 mx-auto mb-4" />
            <h1 className="text-3xl font-bold text-gray-900 mb-2">Complete Your Task</h1>
            <div className="space-y-2">
              <p className="text-xl text-gray-700 font-semibold">{stepInfo.event_name}</p>
              <p className="text-lg text-blue-600 font-medium">{stepInfo.step_name}</p>
            </div>
          </div>

          {/* Task Details */}
          <div className="bg-gray-50 rounded-lg p-6 mb-8">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Task Details</h2>
            <div className="space-y-3">
              <div className="flex items-center">
                <span className="text-sm font-medium text-gray-600 w-24">Event:</span>
                <span className="text-sm text-gray-900">{stepInfo.event_name}</span>
              </div>
              <div className="flex items-center">
                <span className="text-sm font-medium text-gray-600 w-24">Task:</span>
                <span className="text-sm text-gray-900">{stepInfo.step_name}</span>
              </div>
              <div className="flex items-center">
                <span className="text-sm font-medium text-gray-600 w-24">Email:</span>
                <span className="text-sm text-gray-900">{stepInfo.vendor_email}</span>
              </div>
              {stepInfo.time_limit && (
                <div className="flex items-center">
                  <Clock className="mr-2 h-4 w-4 text-yellow-600" />
                  <span className="text-sm font-medium text-gray-600">Time Limit:</span>
                  <span className="text-sm font-medium ml-2 text-blue-600">
                    {stepInfo.time_limit}
                  </span>
                </div>
              )}
              {stepInfo.description && (
                <div>
                  <span className="text-sm font-medium text-gray-600">Description:</span>
                  <p className="text-sm text-gray-900 mt-1">{stepInfo.description}</p>
                </div>
              )}
            </div>
          </div>

          {/* File Upload */}
          <div className="mb-8">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Upload Files</h2>
            
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-blue-400 transition-colors">
              <Upload className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-600 mb-4">
                Upload photos, videos, or documents to show your work
              </p>
              <input
                type="file"
                multiple
                accept="image/*,video/*,.pdf,.doc,.docx,.txt"
                onChange={handleFileSelect}
                className="hidden"
                id="file-upload"
              />
              <label
                htmlFor="file-upload"
                className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 cursor-pointer inline-block"
              >
                Choose Files
              </label>
              <p className="text-xs text-gray-500 mt-2">
                Supports: Images, Videos, PDFs, Documents (Max 25MB each)
              </p>
            </div>

            {/* Selected Files */}
            {files.length > 0 && (
              <div className="mt-6">
                <h3 className="text-sm font-medium text-gray-900 mb-3">Selected Files:</h3>
                <div className="space-y-2">
                  {files.map((file, index) => (
                    <div key={index} className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
                      <div className="flex items-center">
                        <FileText className="h-5 w-5 text-gray-500 mr-3" />
                        <div>
                          <p className="text-sm font-medium text-gray-900">{file.name}</p>
                          <p className="text-xs text-gray-500">
                            {(file.size / 1024 / 1024).toFixed(2)} MB
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => removeFile(index)}
                        className="text-red-500 hover:text-red-700 text-sm"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Comments */}
          <div className="mb-8">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Comments</h2>
            <textarea
              value={comments}
              onChange={(e) => setComments(e.target.value)}
              rows={4}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Add any notes about this completion..."
            />
          </div>

          {/* Error Message */}
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start">
              <AlertCircle className="h-5 w-5 text-red-600 mr-3 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          {/* Submit Button */}
          <div className="text-center">
            <button
              onClick={submitCompletion}
              disabled={submitting || submitted || (files.length === 0 && !comments.trim())}
              className="bg-green-600 text-white px-8 py-4 rounded-lg font-semibold hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-lg w-full"
            >
              {submitting ? 'Submitting...' : submitted ? 'Submitted ✓' : 'Mark Step Complete'}
            </button>
            <p className="text-sm text-gray-500 mt-3">
              Upload files or add comments to complete this step
            </p>
          </div>
        </div>
      </div>

      {/* Success Modal */}
      <Modal
        isOpen={showSuccessModal}
        onClose={() => setShowSuccessModal(false)}
        title="Step Completed!"
        showCloseButton={true}
      >
        <div className="text-center py-4">
          <CheckCircle className="h-16 w-16 text-green-500 mx-auto mb-4" />
          <h3 className="text-xl font-bold text-gray-900 mb-2">Success!</h3>
          <p className="text-gray-600 mb-6">
            Your step has been completed successfully. Thank you for your work!
          </p>
          <button
            onClick={() => setShowSuccessModal(false)}
            className="w-full bg-blue-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-blue-700"
          >
            Close
          </button>
        </div>
      </Modal>
    </div>
  );
}