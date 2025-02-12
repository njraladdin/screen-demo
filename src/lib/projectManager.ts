import { Project } from '@/types/video';

class ProjectManager {
  private readonly STORAGE_KEY = 'screen-demo-projects';

  async saveProject(project: Omit<Project, 'id' | 'createdAt' | 'lastModified'>): Promise<Project> {
    const projects = await this.getProjects();
    
    const newProject: Project = {
      ...project,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      lastModified: Date.now(),
    };

    // Store video blob separately using IndexedDB
    await this.saveVideoBlob(newProject.id, newProject.videoBlob);
    
    // Store project metadata without the blob in localStorage
    const projectMeta = { ...newProject };
    delete (projectMeta as any).videoBlob;
    
    projects.unshift(projectMeta);
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(projects));
    
    return newProject;
  }

  async getProjects(): Promise<Omit<Project, 'videoBlob'>[]> {
    const projectsJson = localStorage.getItem(this.STORAGE_KEY);
    return projectsJson ? JSON.parse(projectsJson) : [];
  }

  async loadProject(id: string): Promise<Project | null> {
    const projects = await this.getProjects();
    const project = projects.find(p => p.id === id);
    
    if (!project) return null;
    
    // Load video blob from IndexedDB
    const videoBlob = await this.loadVideoBlob(id);
    if (!videoBlob) return null;
    
    return { ...project, videoBlob };
  }

  async deleteProject(id: string): Promise<void> {
    const projects = await this.getProjects();
    const filteredProjects = projects.filter(p => p.id !== id);
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(filteredProjects));
    
    // Delete video blob from IndexedDB
    await this.deleteVideoBlob(id);
  }

  async updateProject(id: string, updates: Omit<Project, 'id' | 'createdAt' | 'lastModified'>): Promise<void> {
    const projects = await this.getProjects();
    const projectIndex = projects.findIndex(p => p.id === id);
    
    if (projectIndex === -1) return;

    // Store video blob
    await this.saveVideoBlob(id, updates.videoBlob);
    
    // Update project metadata
    const updatedProject = {
      ...projects[projectIndex],
      ...updates,
      lastModified: Date.now()
    };
    delete (updatedProject as any).videoBlob;
    
    projects[projectIndex] = updatedProject;
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(projects));
  }

  // IndexedDB helpers for video blob storage
  private async saveVideoBlob(id: string, blob: Blob): Promise<void> {
    const db = await this.openDB();
    const tx = db.transaction('videos', 'readwrite');
    const store = tx.objectStore('videos');
    await store.put(blob, id);
  }

  private async loadVideoBlob(id: string): Promise<Blob | null> {
    const db = await this.openDB();
    const tx = db.transaction('videos', 'readonly');
    const store = tx.objectStore('videos');
    
    return new Promise((resolve, reject) => {
      const request = store.get(id);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result as Blob);
    });
  }

  private async deleteVideoBlob(id: string): Promise<void> {
    const db = await this.openDB();
    const tx = db.transaction('videos', 'readwrite');
    const store = tx.objectStore('videos');
    await store.delete(id);
  }

  private async openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('ScreenDemoDB', 1);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('videos')) {
          db.createObjectStore('videos');
        }
      };
    });
  }
}

export const projectManager = new ProjectManager(); 